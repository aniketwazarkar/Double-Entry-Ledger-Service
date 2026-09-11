# Double-Entry Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a task/checklist plan — no implementation code is embedded; the implementer writes the code guided by the interfaces and test intent described per task.

**Goal:** Build a double-entry ledger HTTP service in Node.js/TypeScript/PostgreSQL where the invariant `sum(debits) == sum(credits)` is enforced by the database and proven by an automated concurrency test, with idempotent transfers and bank-statement-style account history.

**Architecture:** Express API → service layer (transferService, accountService, statementService, reconciliationService) → Knex query builder → PostgreSQL. Every transfer is one DB transaction with row-level locking and a deferred constraint trigger that rejects any unbalanced transaction at commit time. Idempotency is enforced by a unique DB constraint on `transactions.idempotency_key`, not application memory.

**Tech Stack:** TypeScript, Node.js, Express, Knex, PostgreSQL 16, Jest + Supertest (integration tests run against a real Dockerized Postgres, never mocked), Docker Compose, zod for request validation.

**Spec:** `docs/PRD.md`

## Global Constraints

- All monetary amounts are integers in minor units (e.g. cents). Floats and non-positive amounts are rejected at the API boundary.
- Balance sign convention: `balance = SUM(credit amounts) - SUM(debit amounts)` over an account's entries, uniformly for every account (wallet/liability convention). The `type` column is stored for future extensibility but does not flip the sign in this iteration.
- A transfer always creates exactly one debit entry (on `from_account_id`) and one credit entry (on `to_account_id`) inside one Transaction.
- Every transfer requires a caller-supplied `idempotency_key`; replays with the same key return the original transaction, never a second one.
- Transfers require both accounts' `currency` to match the request `currency`; cross-currency transfers are rejected.
- No table stores a mutable balance column. Balance and statement running-balance are always derived from the immutable `entries` table.
- Integration tests run against a real PostgreSQL instance (via `docker-compose`), never a mocked DB.
- UUID primary keys (`gen_random_uuid()`, via `pgcrypto`) for accounts, transactions, and entries.

---

## File Structure

- `docker-compose.yml` — Postgres service (+ app service in the final task).
- `knexfile.ts`, `src/db/knex.ts` — Knex config + shared instance.
- `src/db/migrations/` — one migration per schema concern (accounts, transactions, entries, balance-invariant trigger).
- `src/domain/types.ts` — `Account`, `Transaction`, `Entry`, `Direction`, `AccountType`.
- `src/domain/errors.ts` — `NotFoundError`, `ValidationError`, `CurrencyMismatchError`.
- `src/services/accountService.ts` — `createAccount`, `getAccount`, `getBalance`.
- `src/services/transferService.ts` — `transfer`.
- `src/services/statementService.ts` — `getStatement`.
- `src/services/reconciliationService.ts` — `reconcile`.
- `src/api/validation.ts` — zod schemas.
- `src/api/errorHandler.ts` — maps domain errors to HTTP status codes.
- `src/api/routes/{accounts,transfers,transactions,internal}.ts` — route handlers.
- `src/api/app.ts` — Express app assembly (used by both the server and Supertest).
- `src/index.ts` — server entrypoint.
- `scripts/reconcile.ts` — standalone CLI reconciliation check.
- `test/integration/helpers/db.ts` — truncate/teardown helpers.
- `test/integration/*.test.ts` — one file per task.

---

### Task 1: Project Scaffolding, Postgres via Docker Compose, DB Connection

**Files:** `package.json`, `tsconfig.json`, `jest.config.js`, `.env.example`, `docker-compose.yml`, `knexfile.ts`, `src/db/knex.ts`, `test/integration/helpers/db.ts`, `test/integration/db-connection.test.ts`

**Produces:** a configured Knex instance reading `DATABASE_URL`; `truncateAll()`/`closeDb()` test helpers.

- [ ] Scaffold `package.json` (deps: express, knex, pg, uuid, zod; devDeps: typescript, ts-node/ts-node-dev, jest, ts-jest, supertest, @types/*) with scripts: `build`, `dev`, `start`, `migrate`, `migrate:rollback`, `reconcile`, `test`, `test:unit`, `test:integration`.
- [ ] Add `tsconfig.json` (strict mode on) and `jest.config.js` (ts-jest preset, node env).
- [ ] Add `.env.example` with `DATABASE_URL` and `PORT`.
- [ ] Add `docker-compose.yml` with a `postgres:16-alpine` service (user/pass/db `ledger`, healthcheck via `pg_isready`, port 5432), with a named volume `postgres_data` mounted at `/var/lib/postgresql/data` so data survives container removal/rebuild (declared under a top-level `volumes:` key).
- [ ] Add `knexfile.ts` (client `pg`, connection from `DATABASE_URL`, migrations directory `src/db/migrations`) and `src/db/knex.ts` (exports the configured instance).
- [ ] `npm install`; `docker-compose up -d postgres`; confirm container reports healthy.
- [ ] Write `test/integration/helpers/db.ts` with `truncateAll()` (TRUNCATE entries, transactions, accounts RESTART IDENTITY CASCADE) and `closeDb()` (destroys the Knex instance).
- [ ] Write a failing test `test/integration/db-connection.test.ts` that runs a trivial `SELECT 1` through the Knex instance.
- [ ] Run it — it should pass immediately once Postgres + Knex wiring is correct (this test validates plumbing, not new logic); if it fails, fix connection config before any later task.
- [ ] Commit.

---

### Task 2: Accounts Table + `accountService.createAccount` / `getAccount`

**Files:** migration for `accounts`, `src/domain/types.ts`, `src/domain/errors.ts`, `src/services/accountService.ts`, `test/integration/accounts.test.ts`

**Schema — `accounts`:** `id uuid pk default gen_random_uuid()`, `name text not null`, `currency text not null`, `type text not null check in ('asset','liability','equity')`, `created_at timestamptz not null default now()`.

**Produces:**
- `AccountType = 'asset' | 'liability' | 'equity'`, `Direction = 'debit' | 'credit'`, `Account`, `Transaction`, `Entry` types (define all four now even though Transaction/Entry aren't persisted until Task 3 — later tasks depend on the shapes existing).
- `NotFoundError(entity, id)`, `ValidationError(message)`, `CurrencyMismatchError(message)`.
- `accountService.createAccount({ name, currency, type }): Promise<Account>`
- `accountService.getAccount(id): Promise<Account>` — throws `NotFoundError` if missing.

- [ ] Write the accounts migration (include `CREATE EXTENSION IF NOT EXISTS pgcrypto`). Run `npm run migrate`.
- [ ] Define domain types and error classes.
- [ ] Write failing tests: create-then-fetch round-trips all fields; fetching an unknown id rejects with `NotFoundError`.
- [ ] Implement `accountService.createAccount` / `getAccount` against the `accounts` table until tests pass.
- [ ] Commit.

---

### Task 3: Transactions + Entries Tables with the Balance-Invariant Trigger

**Files:** migrations for `transactions`, `entries`, and the trigger; `test/integration/balance-invariant.test.ts`

**Schema — `transactions`:** `id uuid pk`, `idempotency_key text not null unique`, `description text null`, `created_at timestamptz not null default now()`.

**Schema — `entries`:** `id uuid pk`, `transaction_id uuid not null fk -> transactions.id`, `account_id uuid not null fk -> accounts.id`, `direction text not null check in ('debit','credit')`, `amount bigint not null check (amount > 0)`, `currency text not null`, `created_at timestamptz not null default now()`. Indexes: `(account_id, created_at, id)` for statements, `(transaction_id)`.

**Invariant trigger:** a Postgres function + `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED ... FOR EACH STATEMENT` (must be statement-level with `REFERENCING NEW TABLE`, not row-level, since debit+credit are inserted together in one multi-row INSERT and a row-level trigger can't see its sibling row) that, at commit, checks for every `transaction_id` touched: `SUM(debit amounts) - SUM(credit amounts) = 0`, raising an exception otherwise.

- [ ] Write the three migrations (transactions table, entries table, trigger function + constraint trigger). Run `npm run migrate`.
- [ ] Write a failing test proving the trigger is load-bearing: inside a raw Knex transaction, insert one unbalanced pair of entries (e.g. debit 100 / credit 50) under a fresh transaction row and assert the commit throws with an "unbalanced" message; insert a balanced pair and assert it commits and both rows land.
- [ ] Run migrations/tests, fix the trigger SQL if the unbalanced case doesn't throw (common bug: using `FOR EACH ROW` instead of `FOR EACH STATEMENT`).
- [ ] Commit.

---

### Task 4: `transferService.transfer` — Locking, Idempotency, Currency Validation

**Files:** `src/services/transferService.ts`, `test/integration/transfers.test.ts`

**Produces:**
- `TransferInput { idempotencyKey, fromAccountId, toAccountId, amount, currency, description? }`
- `TransferResult { transaction, entries, fromBalance, toBalance, replayed }`
- `transferService.transfer(input): Promise<TransferResult>`

**Logic to implement:**
1. Validate amount is a positive integer, `idempotencyKey` present, `fromAccountId !== toAccountId` — throw `ValidationError` otherwise.
2. Inside one Knex transaction: lock both accounts with `SELECT ... FOR UPDATE`, always ordered ascending by account id (regardless of which is "from"/"to") to prevent deadlocks between opposite-direction transfers on the same pair.
3. Validate both accounts exist (`NotFoundError`) and both match the request currency (`CurrencyMismatchError`).
4. Insert the transaction row with `ON CONFLICT (idempotency_key) DO NOTHING`. If no row came back, the key already exists — fetch the existing transaction + its entries and current balances, and return with `replayed: true`, doing no new inserts.
5. Otherwise insert the debit entry (from) and credit entry (to) in one multi-row insert, compute resulting balances, return with `replayed: false`.

- [ ] Write failing tests: happy-path transfer produces correct balances; identical `idempotencyKey` replay returns the same transaction id and `replayed: true` without moving money twice; non-positive amount → `ValidationError`; mismatched currency → `CurrencyMismatchError`; unknown account → `NotFoundError`.
- [ ] Implement `transferService.transfer` per the logic above until tests pass.
- [ ] Commit.

---

### Task 5: `accountService.getBalance` (current + as-of)

**Files:** modify `src/services/accountService.ts`, `test/integration/balance.test.ts`

**Produces:** `accountService.getBalance(accountId, asOf?: Date): Promise<number>` — throws `NotFoundError` if the account doesn't exist; sums entries up to `asOf` (inclusive) when given, otherwise all entries, using the sign convention from Global Constraints.

- [ ] Write failing tests: fresh account balance is 0; balance reflects transfers in/out correctly; `asOf` before a transfer excludes it, no `asOf` includes it; unknown account throws.
- [ ] Implement `getBalance` against the `entries` table.
- [ ] Commit.

---

### Task 6: `statementService.getStatement` — Paginated, Running Balance

**Files:** `src/services/statementService.ts`, `test/integration/statement.test.ts`

**Produces:**
- `StatementRow { entry, runningBalance }`, `StatementPage { rows, nextCursor }`
- `statementService.getStatement(accountId, { limit?, cursor? }): Promise<StatementPage>`
- Cursor: opaque, keyset-based on `(created_at, id)` ascending — must remain stable as new entries are appended concurrently (no offset pagination).
- Running balance per row = the account's balance as of (and including) that row.

- [ ] Write failing tests: entries come back in chronological order with correct running balance at each step; pagination with a small `limit` returns a `nextCursor`, and fetching the next page continues the running balance correctly (no double-counting or gaps at the page boundary).
- [ ] Implement `getStatement` (keyset `WHERE (created_at, id) > (cursor_created_at, cursor_id)`, `ORDER BY created_at, id`, `LIMIT n+1` to detect `hasMore`).
- [ ] Commit.

---

### Task 7: HTTP API Layer (Express + zod validation + error handling)

**Files:** `src/api/validation.ts`, `src/api/errorHandler.ts`, `src/api/routes/{accounts,transfers,transactions}.ts`, `src/api/app.ts`, `src/index.ts`, `test/integration/api.test.ts`

**Endpoints:**
- `POST /accounts` `{ name, currency, type }` → 201 `Account`
- `GET /accounts/:id` → 200 `Account` | 404
- `GET /accounts/:id/balance?asOf=` → 200 `{ accountId, balance }`
- `GET /accounts/:id/statement?limit=&cursor=` → 200 `StatementPage`
- `POST /transfers` `{ idempotencyKey, fromAccountId, toAccountId, amount, currency, description? }` → 201 (new) or 200 (replayed) `TransferResult`
- `GET /transactions/:id` → 200 `{ transaction, entries }` | 404

**Error mapping:** `ZodError`/`ValidationError`/`CurrencyMismatchError` → 400; `NotFoundError` → 404; anything else → 500 (logged, not leaked to the client).

- [ ] Define zod schemas for each request body/query (reject non-UUID ids, non-positive/non-integer amounts, unknown `type`/currency shape issues at the boundary).
- [ ] Write the error-handling middleware per the mapping above.
- [ ] Write failing end-to-end tests via Supertest against the assembled `app`: full create-accounts → transfer → balance → statement flow; replayed idempotency key returns 200 with the same transaction id; invalid payload → 400; unknown account → 404.
- [ ] Implement routes + `app.ts` (mount routers, `express.json()`, error handler last) + `index.ts` (listen on `PORT`) until tests pass.
- [ ] Commit.

---

### Task 8: `reconciliationService.reconcile` + Internal Endpoint + CLI Script

**Files:** `src/services/reconciliationService.ts`, `src/api/routes/internal.ts` (mounted in `app.ts`), `scripts/reconcile.ts`, `test/integration/reconciliation.test.ts`

**Produces:**
- `ReconciliationResult { balanced, totalDebits, totalCredits }`
- `reconciliationService.reconcile(): Promise<ReconciliationResult>` — sums `entries` directly by direction, independent of any per-account balance logic.
- `GET /internal/reconcile` → `ReconciliationResult` as JSON.
- `npm run reconcile` — CLI wrapper that prints the result and exits non-zero if unbalanced.

- [ ] Write failing tests: reconcile on an empty ledger reports balanced with zero totals; reconcile after several transfers reports balanced with correct totals.
- [ ] Implement `reconcile`, the route, and the CLI script until tests pass.
- [ ] Run the full integration suite to confirm nothing earlier regressed.
- [ ] Commit.

---

### Task 9: Concurrency Test Suite — Proving the Invariant Under Load

**Files:** `test/integration/concurrency.test.ts`

This is the assignment's core deliverable: demonstrating, not asserting, that the invariant holds under concurrency.

- [ ] Write a test that fires many concurrent transfers (mix of both directions between the same two accounts) via `Promise.all`, including several transfers deliberately retried multiple times each under the same `idempotencyKey`, then asserts: exactly one transaction per unique idempotency key was created; `entries` row count is exactly `2 × unique transfers`; `reconciliationService.reconcile()` reports balanced; each account's derived balance matches the expected net movement.
- [ ] Write a second test where many identical concurrent requests race on the *same* idempotency key with no client-side serialization, asserting only one transaction is ever created and the balance reflects the transfer exactly once.
- [ ] Run the suite — it must pass.
- [ ] Sanity-check the test isn't vacuous: temporarily remove the `FOR UPDATE` locking from `transferService.transfer`, rerun, confirm the test now fails or becomes flaky, then revert (`git diff` should show no leftover changes) before committing.
- [ ] Commit.

---

### Task 10: Full Docker Compose Stack, Dockerfile, README

**Files:** `Dockerfile`, `docker-compose.yml` (add `app` service), `README.md`

- [ ] Write a `Dockerfile` (Node 20 alpine, `npm ci`, `npm run build`, container command runs `npm run migrate` then `npm start`).
- [ ] Add an `app` service to `docker-compose.yml` depending on `postgres` being healthy, wired to the same `DATABASE_URL`, exposing port 3000.
- [ ] Run `docker-compose up --build`; confirm Postgres becomes healthy and the app logs that it's listening after migrations run.
- [ ] Manual smoke test with curl: create two accounts, transfer between them, fetch balance + statement, hit `/internal/reconcile` — confirm all values are consistent.
- [ ] Write `README.md`: how to run (`docker-compose up --build`), how to test (`docker-compose up -d postgres`, `npm install`, `npm run migrate`, `npm test`), API summary table, and a note on how the concurrency test proves the invariant.
- [ ] Commit.

---

## Self-Review Notes

- **Spec coverage:** domain model → Tasks 2-3; transfer semantics (idempotency/locking/currency) → Task 4; balance → Task 5; statement → Task 6; HTTP API → Task 7; reconciliation → Task 8; concurrency proof → Task 9; run/deploy → Task 10. All PRD sections covered.
- **Type consistency:** `Account`/`Transaction`/`Entry`/`Direction`/`AccountType` defined once in Task 2, reused by name in every later task; `TransferInput`/`TransferResult` (Task 4), `StatementPage`/`StatementRow` (Task 6), `ReconciliationResult` (Task 8) each defined once and consumed as-is downstream.
