# Double-Entry Ledger Service

A ledger service where `sum(debits) == sum(credits)` is enforced by the database — not application trust — and proven under concurrency, not merely asserted. See [`docs/PRD.md`](docs/PRD.md) for the full design rationale and [`docs/superpowers/plans/2026-09-11-double-entry-ledger.md`](docs/superpowers/plans/2026-09-11-double-entry-ledger.md) for the implementation plan.

## Run locally

```bash
docker compose up --build
```

Postgres starts, the app waits for it to be healthy, runs migrations, and listens on `localhost:3000`.

## Run tests

```bash
docker compose up -d postgres
npm install
cp .env.example .env   # DATABASE_URL + PORT
npm run migrate
npm test
```

`test/integration/concurrency.test.ts` is the core proof: it fires many concurrent transfers — including several deliberately retried under duplicate idempotency keys, and a batch racing on one brand-new key with no client-side serialization — against a real Postgres instance, then asserts the global debit/credit sums stay equal, exactly one transaction exists per unique key, and account balances match the expected net movement. All integration tests run against real Postgres (via Docker), never a mock.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/accounts` | Create an account: `{ name, currency, type }` |
| `GET` | `/accounts/:id` | Fetch account metadata |
| `GET` | `/accounts/:id/balance?asOf=` | Current or point-in-time balance |
| `GET` | `/accounts/:id/statement?limit=&cursor=` | Paginated history with a running balance per row |
| `POST` | `/transfers` | Move money: `{ idempotencyKey, fromAccountId, toAccountId, amount, currency, description? }` |
| `GET` | `/transactions/:id` | Full detail of a transaction and its entries |
| `GET` | `/internal/reconcile` | Recomputes global debit/credit totals directly from `entries` |

Amounts are integers in minor units (e.g. cents). Every transfer requires a caller-supplied `idempotencyKey`; replaying the same key returns the original transaction (`replayed: true`, HTTP 200) instead of moving money again. See `docs/PRD.md`'s Error Contract section for the exact status code and body shape of every failure case.

## How the invariant is enforced

- Every transfer runs inside one database transaction, with both accounts locked (`SELECT ... FOR UPDATE`, always in ascending account-id order) to prevent deadlocks between two transfers on the same account pair.
- A deferred Postgres constraint trigger checks, at COMMIT, that every transaction's entries sum to zero (debits minus credits) — this is checked by the database itself, not trusted to application code.
- Idempotency is a database-level unique constraint on `transactions.idempotency_key`, not an in-memory cache, so it holds even under concurrent retries or multiple app instances.

## Proving the invariant yourself

```bash
npm run reconcile
```

runs the same check as `GET /internal/reconcile` as a standalone script against the current database, exiting non-zero if the ledger is ever found unbalanced.
