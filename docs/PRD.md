# Double-Entry Ledger Service — PRD

## Why we're building this

We need a ledger that acts as the single source of truth for money movement across the product. Three groups depend on it, and they don't all care about the same things:

- **Product engineers** (wallets, credits, promos, refunds) want one API they can hit to answer "how much is in this account, and how did it get there," and it has to hold up under real concurrency, not just in a demo.
- **Finance** wants to be able to pull any account like a bank statement: entries in order, with a running balance, and history that never quietly changes after the fact.
- **Calling services** will retry on timeout. A retried call can never move money twice.

The one rule that can't bend: at any moment, under any amount of concurrent traffic, `sum(debits) == sum(credits)`. We're not going to just assert that's true; we want to be able to prove it, which is really what shapes the whole architecture. That means pushing the invariant down into the database instead of trusting application code, and it means shipping a concurrency test that actually tries to break the thing.

Stack's already settled: Node.js + TypeScript on Postgres, Docker Compose to run it locally, a DB-enforced invariant backed by a concurrency test suite, idempotency keys supplied by the client, one currency per account (but the system itself is multi-currency), and a balance endpoint plus a paginated statement with a running balance.

## Domain model

Standard double-entry bookkeeping, just adapted for a product context:

**Account.** `id`, `name`, `currency` (ISO 4217, or a custom code like `POINTS`), `type` (`asset` / `liability` / `equity`, we need this so "which side is the normal balance on" is unambiguous, and so external funding sources net out to zero), `created_at`. Balance is never a column we write to directly; it's always derived from entries, whether that's computed live or cached and reconciled.

**Transaction.** The atomic, immutable unit. `id`, `idempotency_key` (unique), `description`/`metadata`, `created_at`. Groups two or more entries, and by construction has to balance.

**Entry** (ledger line, posting, whatever you want to call it). `id`, `transaction_id`, `account_id`, `direction` (`debit`/`credit`), `amount` (positive, integer minor units, never a float), `currency` (has to match the account's), `created_at`. Entries are append-only. Nothing ever updates or deletes one.

The invariant is enforced per-transaction, not just globally: for every transaction, `sum(debit amounts) == sum(credit amounts)`, and every transaction touches at least two entries across at least two distinct accounts. If that holds for every row that's ever inserted, the global invariant just falls out of it for free.

A **transfer** is one Transaction with exactly one debit entry and one credit entry. There's no way to create money from nothing; every entry needs a matching opposite entry in the same transaction, so value only ever moves between accounts, it's never conjured.

## How this maps to real product scenarios

The ledger itself has no idea what a "wallet" or a "refund" is, it only ever executes `POST /transfers`. All the product-specific meaning lives in which accounts the calling service picks. A few worked examples to make that concrete:

**Wallet top-up.** User adds money via a payment provider. `payments_clearing` (asset, money received from the processor, pending settlement) and `user_123_wallet` (liability, what the company owes the user on demand). On a successful capture: `transfer(from: payments_clearing, to: user_123_wallet, amount: 5000, currency: USD)`. The wallet goes up 5000, clearing goes down 5000 (that gets offset later by settlement/reconciliation outside the ledger's scope, not something we model here).

**Cashback / promo credit.** `promotions_funding` (equity, running total of promotional spend; it's expected to go negative over time, that's not a bug) and `user_123_wallet`. The promotion service decides eligibility, amount, and campaign attribution, none of that is the ledger's business. Once it's decided, it just calls `transfer(from: promotions_funding, to: user_123_wallet, amount: 200, currency: USD, description: "cashback:campaign-42")`. The ledger only checks that it's a real transfer between two real accounts with matching currency; "campaign" lives in the description field for traceability, not in any ledger logic. Finance can see the total giveaway by reading `promotions_funding`'s statement like any other account.

**Refund.** Entries from the original transaction never get touched, append-only, no exceptions. A refund is just a new transfer going the other way. If the original was `transfer(from: user_123_wallet, to: merchant_456_account, amount: 1500)`, a full refund is `transfer(from: merchant_456_account, to: user_123_wallet, amount: 1500, idempotency_key: "refund-of-<original_transaction_id>")`. Partial refund, smaller amount, same idea. The new transaction's metadata can point back at the original id for reporting, that's a convention callers follow, not something the ledger enforces as a foreign key, since one transaction has no structural relationship to another. It's on the calling service to pick a deterministic idempotency key for the refund (derived from the original transaction's id, say) so a retried refund request doesn't double-refund someone.

## API surface

- `POST /accounts`: create an account (`name`, `currency`, `type`)
- `GET /accounts/:id`: account metadata
- `GET /accounts/:id/balance`: current balance, or pass `as_of` for a point-in-time balance (sums entries up to that timestamp)
- `POST /transfers`: move money between two accounts. Body: `idempotency_key`, `from_account_id`, `to_account_id`, `amount`, `currency`, `description`. Both accounts need matching currency. Returns the created transaction plus resulting balances. Replay the same idempotency key and you get the original result back (same status, same body) instead of a second movement.
- `GET /accounts/:id/statement`: paginated, time-ordered entries for an account, each row showing amount, direction, the counterparty transaction, and the running balance right after that entry, bank statement style. Pagination is keyset-based on `(created_at, entry_id)` so history stays stable even while new entries keep landing.
- `GET /transactions/:id`: full detail on a transaction, all its entries, for audit/debugging.

All amounts are integers, minor units. Float amounts, zero/negative amounts, cross-currency transfers, and unknown accounts all get rejected with clear 4xx errors.

### Error contract

Every error comes back as `{ "error": "<ErrorName>", "message": "<human-readable detail>" }`, and validation errors also carry a `details` array with the per-field issues. Status codes are fixed per error type so callers can branch on the code without parsing the message:

| Scenario | HTTP Status | `error` value | Notes |
|---|---|---|---|
| Malformed/missing field (non-UUID account id, missing `idempotencyKey`, etc.) | 400 | `ValidationError` | Includes zod's `details` array: path plus issue per field. |
| Non-integer, zero, or negative `amount` | 400 | `ValidationError` | Amounts are minor-unit integers only; floats get rejected before we ever touch the DB. |
| `fromAccountId` equals `toAccountId` | 400 | `ValidationError` | A transfer has to move value between two distinct accounts. |
| Transfer currency doesn't match one or both accounts | 400 | `CurrencyMismatchError` | No implicit conversion, you transfer in the accounts' shared currency or not at all. |
| Referenced account doesn't exist | 404 | `NotFoundError` | Covers `GET /accounts/:id`, `.../balance`, `.../statement`, and either side of `POST /transfers`. |
| Referenced transaction doesn't exist | 404 | `NotFoundError` | `GET /transactions/:id`. |
| Same `idempotencyKey`, identical request | 200 (not 201) | not an error | Returns the original transaction unchanged, with `replayed: true` so the caller knows nothing new happened. |
| Same `idempotencyKey`, but `fromAccountId`/`toAccountId`/`amount`/`currency` differ from the original | 200 | not an error, for now | The stored transaction wins; whatever's different in the new request just gets ignored. Calling this out explicitly as a known sharp edge rather than pretending it's fine, see the note below. |
| Unexpected server/DB error | 500 | `InternalError` | Never leaks a stack trace or raw DB error text to the client; that gets logged server-side only. |

**Worth flagging:** right now the API won't notice (or reject) a replayed idempotency key whose other fields don't match the original, same key, different amount, and it'll just hand back the original transaction. That could genuinely surprise a caller who thought they were sending something new. The stricter fix is to hash the full payload alongside the key and 409 on a mismatch, but that's more than we need for this iteration, noted as a follow-up rather than something we're quietly shipping as "correct."

## Correctness and concurrency: where most of the risk lives

This is the part we can't hand-wave, so here's the actual plan:

1. **Every transfer is one DB transaction.** All the entry inserts for a transfer happen inside a single Postgres transaction, either every row lands or none of them do.

2. **The balance invariant lives in the database, not just in application code.**
   - A deferred constraint trigger that checks, per `transaction_id`, that `SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) = 0` before commit. Has to be a trigger rather than a plain `CHECK` because the constraint spans multiple rows inserted together.
   - A `UNIQUE` constraint on `transactions.idempotency_key`. Two concurrent retries of the same request will race on insert; whichever one loses gets a unique-violation, and the app maps that to "just return the original transaction" instead of surfacing an error.
   - Foreign keys tying `entries.account_id` to `accounts.id` and `entries.transaction_id` to `transactions.id`, plus `NOT NULL` and `CHECK (amount > 0)` on entries.

3. **Locking for balance-dependent decisions.** If/when overdraft rules come into play and we need to know "does this account actually have enough for this debit," we'll use `SELECT ... FOR UPDATE` on the source account (or `SERIALIZABLE` isolation with retry on serialization failure) so two concurrent transfers debiting the same account can't both work off a stale read. We lock in ascending `account_id` order across both legs so two transfers touching the same pair of accounts in opposite directions can't deadlock each other.

4. **No mutable balance column to go stale.** Balance is always `SUM(credits) - SUM(debits)` over entries (sign flips depending on account type), computed on read, or cached and reconciled against the entry sum in tests. The entries table is the only thing that's ever authoritative.

5. **Two things that actually prove this works, not just claim it:**
   - An integration test that fires N concurrent transfer requests at a real Postgres instance, mixed directions, some deliberately retried with duplicate idempotency keys, some racing on the same accounts, and then checks: total debits equal total credits globally, each account's derived balance matches what we independently expect, no duplicate transaction got created from a repeated key, and the entries row count is exactly 2x the number of unique transfers that actually got accepted.
   - A reconciliation endpoint (or a CLI script, `GET /internal/reconcile`) that recomputes the global debit/credit sums straight from the `entries` table and reports pass or fail. This is the artifact finance or a reviewer can run themselves, any time, against a live DB.

## Tech plan

- **Language/runtime:** TypeScript on Node.js
- **Framework:** Express (or Fastify). The API surface is small, so keep the framework thin.
- **DB:** Postgres, via a query builder with a good raw-SQL escape hatch, since we need custom triggers and explicit `FOR UPDATE` control. Knex fits better here than Prisma for exactly that reason.
- **Migrations:** SQL migration files (Knex) for the accounts/transactions/entries tables, the constraints, and indexes: `entries(account_id, created_at)` for statements, a unique index on `transactions.idempotency_key`.
- **Testing:** Jest or Vitest for unit tests on validation and business logic. Integration tests run against a real Postgres in Docker for anything transactional or concurrency-related; those can't be mocked, since the entire point is proving the DB actually enforces correctness.
- **Local run:** `docker-compose.yml` with a `postgres` service and an `app` service. `docker-compose up` (or `npm run dev`) brings the whole stack up, migrations run on startup.
- **Repo layout:**
  - `src/db/migrations/`: schema and constraints
  - `src/domain/`: Account, Transaction, Entry types and invariant logic
  - `src/services/`: `transferService`, `accountService`, `statementService`
  - `src/api/`: route handlers, request validation (zod)
  - `src/db/`: connection pool, transaction helpers (lock ordering, retry-on-serialization-failure)
  - `test/integration/concurrency.test.ts`: the invariant-proof test
  - `test/integration/idempotency.test.ts`
  - `test/unit/`: domain and validation tests

## How we'll verify it's actually done

1. `docker-compose up`: Postgres and the app come up, migrations run automatically.
2. Manual smoke test with curl or an HTTP file: create two accounts, transfer funds, pull the balance and the statement, check the running balance math by hand.
3. Retry the same transfer with the same idempotency key; confirm there's no duplicate entry and the same response comes back.
4. Try a cross-currency transfer, and a negative-amount one; confirm both get a clean 4xx.
5. `npm test`: unit tests pass.
6. Run the integration/concurrency suite against the Dockerized Postgres; confirm it fires concurrent transfers, asserts debits equal credits with zero duplicates, and (as a sanity check that the test isn't vacuous) that it would actually fail if we pulled out the DB constraint or the locking.
7. Run the reconciliation script/endpoint against the post-test DB state and confirm it comes back balanced.