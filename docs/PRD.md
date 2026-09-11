# PRD: Double-Entry Ledger Service

## Context

This is a greenfield take-home assignment: build a ledger service that is the system of record for money movement inside a product. Three consumer classes depend on it:

- **Product engineers** (wallets, credits, promotions, refunds) need one API to answer "how much does this account hold, and how did it get there" — correct even under heavy concurrency.
- **Finance** needs to read any account like a bank statement: ordered movements with a running balance, and immutable history (yesterday's numbers never change).
- **Calling services** retry on timeout, so a retried request must never move money twice.

The non-negotiable invariant: **at all times, under any concurrency, sum(debits) == sum(credits)**. The system must be able to *prove* this holds, not just assert it — this drives the architecture (DB-enforced constraints, not application-level trust) and the deliverables (a concurrency test that actually exercises the invariant).

Stack decisions already made with the user: **Node.js + TypeScript + PostgreSQL**, **Docker Compose** for local run, **DB-enforced invariant + concurrency test suite** as the correctness strategy, **client-supplied idempotency key**, **single-currency-per-account / multi-currency system**, and a **balance + paginated statement-with-running-balance** query API.

## Domain Model

Classic double-entry bookkeeping, adapted for a product ledger:

- **Account**: `id`, `name`, `currency` (ISO 4217 or custom code, e.g. `USD`, `POINTS`), `type` (e.g. `asset`, `liability`, `equity` — needed so "normal balance side" is well-defined and external funding sources net to zero), `created_at`. Balance is *never* a stored mutable column — it is derived (or materialized+reconciled) from entries.
- **Transaction**: the atomic, immutable unit of money movement. `id`, `idempotency_key` (unique), `description`/`metadata`, `created_at`. A transaction groups two or more **entries** and by construction must balance.
- **Entry** (a.k.a. ledger line / posting): `id`, `transaction_id`, `account_id`, `direction` (`debit`|`credit`), `amount` (positive, minor units — integer, never float), `currency` (must match the account's currency), `created_at`. Entries are append-only, never updated or deleted.
- Invariant enforced per-transaction (not just globally): `sum(debit amounts) == sum(credit amounts)` for every transaction, and every transaction has ≥2 entries touching ≥2 distinct accounts. Global invariant is a corollary of this holding for every row ever inserted.

Money movement (`transfer`) is expressed as: create one Transaction with exactly one debit entry and one credit entry (extendable to multi-leg transactions for splits/fees later, same mechanism). No API creates money from nothing — every entry requires a matching opposite entry in the same transaction, so value only ever moves between accounts.

## Domain Usage Scenarios

These worked examples show how product-level concepts (which the ledger has no special knowledge of) map onto plain transfers between accounts. In every case, the ledger only ever executes `POST /transfers` — there is no promotion-, refund-, or wallet-specific code path in the ledger itself; the calling service is responsible for choosing the right `from`/`to` accounts.

**1. Wallet top-up (user adds money via a payment provider)**

- Accounts involved: `payments_clearing` (type `asset` — represents money received from the payment processor, pending settlement), `user_123_wallet` (type `liability` — money the company owes back to the user on demand).
- On successful payment capture: `transfer(from: payments_clearing, to: user_123_wallet, amount: 5000, currency: USD)`.
- Result: `user_123_wallet` balance +5000. `payments_clearing` balance -5000 (offset later by the company's own settlement/reconciliation process outside this ledger's scope, or by a further transfer once funds are swept to a bank-holding account — not modeled here).

**2. Cashback / promotional credit**

- Accounts involved: `promotions_funding` (type `equity` — represents cumulative promotional spend, expected to run negative over time, which is normal and expected, not an error condition), `user_123_wallet`.
- The **promotion service** decides eligibility, amount, and campaign attribution (all outside the ledger). Once decided, it calls `transfer(from: promotions_funding, to: user_123_wallet, amount: 200, currency: USD, description: "cashback:campaign-42")`.
- The ledger enforces only that this is a real transfer between two real accounts of matching currency — it has no concept of "campaign" or "cashback"; that context lives in the `description`/metadata field for traceability, not in ledger business logic.
- Finance can see the running total the company has given away by reading `promotions_funding`'s statement, since it is a real account like any other.

**3. Refund (full or partial reversal of a prior transfer)**

- The original transaction's entries are never modified or deleted — the ledger is append-only by design (Global Constraints).
- A refund is a **new transfer** in the reverse direction: if the original was `transfer(from: user_123_wallet, to: merchant_456_account, amount: 1500)`, a full refund is `transfer(from: merchant_456_account, to: user_123_wallet, amount: 1500, idempotency_key: "refund-of-<original_transaction_id>")`. A partial refund uses a smaller `amount`.
- The optional `description`/metadata field on the new transaction can reference the original transaction's id (e.g. `"refund_of": "<original_transaction_id>"`) purely for reporting/traceability — this is a convention for callers, not a structural foreign key the ledger enforces, since a transaction has no business rule tying it to another transaction.
- The calling service is responsible for choosing a fresh, deterministic `idempotency_key` for the refund (e.g. derived from the original transaction id) so a retried refund request doesn't double-refund.

**4. Fee split (e.g. a purchase where the platform takes a cut)**

- Out of scope for the initial API (which models a transfer as exactly one debit + one credit — see Domain Model), but the schema already supports it without redesign: a "split" is a single Transaction with more than two entries (e.g. debit buyer 1000, credit merchant 950, credit platform_fees 50), still subject to the same per-transaction balance trigger. This is noted here so it's clear the two-entry `/transfers` endpoint is a special case of the general model, not a structural limit.

## API Surface

- `POST /accounts` — create an account (`name`, `currency`, `type`).
- `GET /accounts/:id` — account metadata.
- `GET /accounts/:id/balance` — current balance (optionally `as_of` timestamp for a point-in-time balance, computed by summing entries up to that time).
- `POST /transfers` — move money between two accounts. Body: `idempotency_key`, `from_account_id`, `to_account_id`, `amount`, `currency`, `description`. Requires same-currency accounts. Returns the created Transaction + resulting balances. Replaying the same `idempotency_key` returns the original result (200/201, same body) instead of creating a second movement.
- `GET /accounts/:id/statement` — paginated, time-ordered list of entries for the account, each row showing amount, direction, counterparty transaction, and **running balance after that entry** (bank-statement semantics). Cursor-based pagination (keyset on `(created_at, entry_id)`) so history is stable even as new entries are appended concurrently.
- `GET /transactions/:id` — full detail of a transaction (all its entries), for audit/debugging.

All amounts are integers in minor units; API rejects float amounts, zero/negative amounts, cross-currency transfers, and unknown accounts with clear 4xx errors.

### Error Contract

Every error response is JSON: `{ "error": "<ErrorName>", "message": "<human-readable detail>" }` (validation errors additionally include a `details` array of per-field issues). Status codes are fixed per error type so callers can branch on the code alone without parsing `message`:

| Scenario | HTTP Status | `error` value | Notes |
|---|---|---|---|
| Malformed/missing request field (e.g. non-UUID account id, missing `idempotencyKey`) | 400 | `ValidationError` | Includes zod's `details` array (path + issue per field). |
| Non-integer, zero, or negative `amount` | 400 | `ValidationError` | Amounts are minor-unit integers only; floats are rejected before any DB call. |
| `fromAccountId` equals `toAccountId` | 400 | `ValidationError` | A transfer must move value between two distinct accounts. |
| Transfer currency doesn't match one or both accounts' currency | 400 | `CurrencyMismatchError` | No implicit conversion; caller must transfer in the accounts' shared currency. |
| Referenced account does not exist | 404 | `NotFoundError` | Applies to `GET /accounts/:id`, `GET /accounts/:id/balance`, `GET /accounts/:id/statement`, and either side of `POST /transfers`. |
| Referenced transaction does not exist | 404 | `NotFoundError` | `GET /transactions/:id`. |
| Repeated `idempotencyKey` with an **identical** request | 200 (not 201) | — (not an error) | Returns the original transaction body unchanged; `replayed: true` in the response signals no new movement occurred. |
| Repeated `idempotencyKey` with a **different** `fromAccountId`/`toAccountId`/`amount`/`currency` than the original request | 200 | — (not an error in this iteration) | The stored transaction wins; the mismatched fields in the new request are silently ignored. Flagged here as a known sharp edge — see Out of Scope note below — rather than silently modeled as correct behavior. |
| Unexpected server/DB error | 500 | `InternalError` | Never leaks stack traces or raw DB error text to the client; logged server-side only. |

**Known edge case, explicitly out of scope for this iteration:** the API does not detect or reject an idempotency-key replay whose *other* fields differ from the original request (e.g. same key, different amount) — it always returns the original transaction, which may surprise a caller who changed the amount and expected an error. A stricter implementation would hash the full request payload alongside the key and return `409 Conflict` on a mismatch; noted here as a candidate follow-up rather than built now, to keep the idempotency mechanism to the single DB unique-constraint approach described in Correctness & Concurrency Strategy.

## Correctness & Concurrency Strategy

This is the core engineering risk in the assignment, so it gets the most explicit design:

1. **Every transfer is one DB transaction.** All entry inserts for a transfer happen inside a single Postgres transaction; either all rows land or none do.
2. **DB-level balance invariant, not just app-level checks:**
   - A `CHECK` constraint / trigger that validates, per `transaction_id`, `SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) = 0` before commit (Postgres deferred constraint trigger, since the check spans multiple rows inserted together).
   - A `UNIQUE` constraint on `transactions.idempotency_key` — concurrent retries of the same request race on `INSERT` and the loser gets a unique-violation, which the app maps to "return the original transaction" instead of erroring.
   - Foreign keys `entries.account_id -> accounts.id`, `entries.transaction_id -> transactions.id`, `NOT NULL`/`CHECK (amount > 0)` on entries.
3. **Concurrency control for balance-dependent decisions** (e.g. "does this account have sufficient balance for this debit," if/when overdraft rules apply): use `SELECT ... FOR UPDATE` row locks on the source account (or Postgres `SERIALIZABLE` isolation with retry-on-serialization-failure) so two concurrent transfers debiting the same account can't both read a stale balance. Locking order is by `account_id` ascending across both legs to avoid deadlocks when two transfers touch the same pair of accounts in opposite directions.
4. **No stored mutable balance to go stale**: balance = `SUM(credits) - SUM(debits)` (sign convention per account type) over entries, either computed on read or maintained as a materialized/cached summary that is reconciled against the entry sum in tests — the entries table is always the source of truth.
5. **Proof, not assertion** — two concrete deliverables:
   - **Invariant test**: an integration test that spins up N concurrent transfer requests (mixed directions, some deliberately retried with duplicate idempotency keys, some racing on the same accounts) against a real Postgres instance, then asserts: (a) `SUM(all debit entries) == SUM(all credit entries)` globally, (b) each account's derived balance matches an independently-computed expectation, (c) no duplicate transaction was created for a repeated idempotency key, (d) row count of entries is exactly `2 × number of unique transfers accepted`.
   - **Reconciliation endpoint/script** (`GET /internal/reconcile` or a CLI script) that recomputes global debit/credit sums directly from the `entries` table and returns pass/fail — the "show your work" artifact for finance/reviewers, runnable at any time against a live DB.

## Tech Plan

- **Language/runtime**: TypeScript on Node.js.
- **Framework**: Express (or Fastify) for the HTTP layer — thin, since the API surface is small.
- **DB**: PostgreSQL, accessed via a query builder/ORM with good raw-SQL escape hatches for the constraint triggers and locking (Knex or Prisma — Knex is a better fit here since we need custom triggers/`FOR UPDATE` control that Prisma makes awkward).
- **Migrations**: SQL migration files (Knex migrations) defining accounts/transactions/entries tables, constraints, indexes (`entries(account_id, created_at)` for statements, unique index on `transactions.idempotency_key`).
- **Testing**: Jest (or Vitest) for unit tests on validation/business logic; integration tests running against a real Postgres (via Docker) for the transactional/concurrency guarantees — these must not be mocked, since the whole point is to prove DB-enforced correctness.
- **Local run**: `docker-compose.yml` with a `postgres` service and an `app` service; `npm run dev` / `docker-compose up` brings up the full stack; a seed/migration step on startup.
- **Repo layout** (indicative):
  - `src/db/migrations/` — schema + constraints
  - `src/domain/` — Account, Transaction, Entry types and invariant logic
  - `src/services/` — `transferService`, `accountService`, `statementService`
  - `src/api/` — route handlers, request validation (e.g. zod)
  - `src/db/` — connection pool, transaction helpers (lock ordering, retry-on-serialization-failure)
  - `test/integration/concurrency.test.ts` — the invariant-proof test
  - `test/integration/idempotency.test.ts`
  - `test/unit/` — domain + validation tests

## Out of Scope (for this iteration)

- Multi-currency FX conversion (transfers require matching currencies).
- AuthN/AuthZ, rate limiting, multi-tenant isolation.
- Horizontal multi-instance scaling concerns beyond what Postgres locking already guarantees (single app instance assumed; DB-level guarantees make this safe to scale later without redesign).
- Reversal/refund as a distinct first-class operation — modeled as just another transfer in the opposite direction, which the existing primitive already supports; a `related_transaction_id` metadata field can link them if needed, but no special endpoint.
- CI pipeline, observability/metrics, structured logging beyond basics.

## Verification Plan

1. `docker-compose up` — Postgres + app start, migrations run automatically.
2. Manual smoke test via curl/HTTP file: create two accounts, transfer funds, fetch balance and statement, confirm running balance math.
3. Retry the same transfer with the same `idempotency_key` — confirm no duplicate entries, same response returned.
4. Attempt a cross-currency or negative-amount transfer — confirm clean 4xx rejection.
5. Run `npm test` — unit tests pass.
6. Run the integration/concurrency test suite against the Dockerized Postgres — confirm it fires concurrent transfers and asserts sum(debits) == sum(credits) with zero duplicates, and that the test would *fail* if the DB constraint/locking were removed (sanity-check the test isn't vacuous, e.g. temporarily by reviewing it induces real contention).
7. Run the reconciliation script/endpoint against the post-test DB state and confirm it reports balanced.
