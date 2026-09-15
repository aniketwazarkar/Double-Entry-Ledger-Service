import type { Knex } from 'knex';
import db from '../db/knex';
import { Direction, Entry, Transaction } from '../domain/types';
import { CurrencyMismatchError, NotFoundError, ValidationError } from '../domain/errors';

export interface TransferInput {
  idempotencyKey: string;
  fromAccountId: string;
  toAccountId: string;
  /** Integer amount in minor units, strictly positive. */
  amount: number;
  currency: string;
  description?: string | null;
}

export interface TransferResult {
  transaction: Transaction;
  entries: Entry[];
  /** balance = SUM(credit amounts) - SUM(debit amounts) */
  fromBalance: number;
  toBalance: number;
  /** True when this call matched an existing idempotency key and moved no money. */
  replayed: boolean;
}

interface TransactionRow {
  id: string;
  idempotency_key: string;
  description: string | null;
  created_at: Date;
}

interface EntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: Direction;
  /** `bigint` — node-postgres hands these back as strings. */
  amount: string | number;
  currency: string;
  created_at: Date;
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    description: row.description,
    createdAt: row.created_at,
  };
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    // bigint arrives as a string from pg; Entry.amount is a TS number.
    amount: Number(row.amount),
    currency: row.currency,
    createdAt: row.created_at,
  };
}

/**
 * Validates the request and lowercases both account ids once, up front.
 * Postgres uuid comparison is case-insensitive, so without this a same-account
 * transfer could slip past the self-transfer check, and mixed-case ids for the
 * same pair could sort into a different lock order and deadlock.
 */
function normalizeAndValidate(input: TransferInput): TransferInput {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    throw new ValidationError('idempotencyKey is required');
  }
  if (typeof input.currency !== 'string' || input.currency.trim() === '') {
    throw new ValidationError('currency is required');
  }
  if (
    typeof input.fromAccountId !== 'string' ||
    typeof input.toAccountId !== 'string' ||
    !input.fromAccountId ||
    !input.toAccountId
  ) {
    throw new ValidationError('fromAccountId and toAccountId are required');
  }

  const normalized: TransferInput = {
    ...input,
    fromAccountId: input.fromAccountId.toLowerCase(),
    toAccountId: input.toAccountId.toLowerCase(),
  };

  if (normalized.fromAccountId === normalized.toAccountId) {
    throw new ValidationError('fromAccountId and toAccountId must differ');
  }
  // Must be a safe integer so it round-trips cleanly through the bigint column.
  if (!Number.isSafeInteger(normalized.amount)) {
    throw new ValidationError('amount must be an integer number of minor units');
  }
  if (normalized.amount <= 0) {
    throw new ValidationError('amount must be positive');
  }

  return normalized;
}

/**
 * Locks both accounts FOR UPDATE in ascending id order (not "from" then "to").
 * This is what prevents deadlocks: two opposite transfers over the same pair
 * always request the lower id first, so lock order can never cycle.
 */
async function lockAccounts(
  trx: Knex.Transaction,
  input: TransferInput
): Promise<Map<string, { id: string; currency: string }>> {
  const orderedIds = [input.fromAccountId, input.toAccountId].sort();
  const locked = new Map<string, { id: string; currency: string }>();

  for (const id of orderedIds) {
    const row = await trx('accounts').select('id', 'currency').where({ id }).forUpdate().first();
    if (row) {
      locked.set(id, row);
    }
  }

  return locked;
}

function assertAccount(
  locked: Map<string, { id: string; currency: string }>,
  accountId: string,
  requestCurrency: string,
  label: string
): void {
  const account = locked.get(accountId);
  if (!account) {
    throw new NotFoundError('Account', accountId);
  }
  if (account.currency !== requestCurrency) {
    throw new CurrencyMismatchError(
      `${label} account ${accountId} is denominated in ${account.currency}, ` +
        `but the transfer requested ${requestCurrency}`
    );
  }
}

/** balance = SUM(credit amounts) - SUM(debit amounts), for the given accounts. */
async function balancesFor(
  trx: Knex.Transaction,
  accountIds: string[]
): Promise<Map<string, number>> {
  const { rows } = await trx.raw(
    `SELECT account_id,
            COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS balance
       FROM entries
      WHERE account_id = ANY(?)
      GROUP BY account_id`,
    [accountIds]
  );

  const balances = new Map<string, number>(accountIds.map((id) => [id, 0]));
  for (const row of rows as { account_id: string; balance: string }[]) {
    balances.set(row.account_id, Number(row.balance));
  }
  return balances;
}

/** Debit leg first, then credit, so callers see a stable order on both paths. */
async function entriesFor(trx: Knex.Transaction, transactionId: string): Promise<Entry[]> {
  const rows = await trx<EntryRow>('entries')
    .where({ transaction_id: transactionId })
    .orderByRaw("CASE direction WHEN 'debit' THEN 0 ELSE 1 END, id");
  return rows.map(toEntry);
}

export async function transfer(rawInput: TransferInput): Promise<TransferResult> {
  // Validate before opening a DB transaction, and shadow rawInput so the rest
  // of this function can only see the normalised (lowercased) ids.
  const input = normalizeAndValidate(rawInput);

  return db.transaction(async (trx) => {
    const locked = await lockAccounts(trx, input);
    assertAccount(locked, input.fromAccountId, input.currency, 'source');
    assertAccount(locked, input.toAccountId, input.currency, 'destination');

    // Claim the idempotency key; ON CONFLICT DO NOTHING means a replay gets no row
    // back. If two concurrent requests race on the same new key, Postgres blocks
    // the loser until the winner commits, so by the time we fall through to the
    // SELECT below, the winner's row is guaranteed to be visible.
    const inserted = await trx.raw<{ rows: TransactionRow[] }>(
      `INSERT INTO transactions (idempotency_key, description)
       VALUES (?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyKey, input.description ?? null]
    );

    const transactionRow = inserted.rows[0];

    if (!transactionRow) {
      // Replay: return the original transaction untouched. No entries are
      // written, so no money moves a second time.
      const existing = await trx<TransactionRow>('transactions')
        .where({ idempotency_key: input.idempotencyKey })
        .first();

      if (!existing) {
        // Should be unreachable (see comment above) — fail loudly instead of
        // silently inventing a second transaction for the same key.
        throw new Error(
          `idempotency key ${input.idempotencyKey} conflicted on insert but could not be read back`
        );
      }

      // Sequential (not Promise.all) since a Knex transaction is one connection.
      const entries = await entriesFor(trx, existing.id);
      // Read balances now, in this locked transaction, so they're current.
      const balances = await balancesFor(trx, [input.fromAccountId, input.toAccountId]);

      return {
        transaction: toTransaction(existing),
        entries,
        fromBalance: balances.get(input.fromAccountId) ?? 0,
        toBalance: balances.get(input.toAccountId) ?? 0,
        replayed: true,
      };
    }

    // One debit (source) + one credit (destination); a DB trigger checks the
    // pair balances at COMMIT.
    const entryRows = await trx<EntryRow>('entries')
      .insert([
        {
          transaction_id: transactionRow.id,
          account_id: input.fromAccountId,
          direction: 'debit',
          amount: String(input.amount),
          currency: input.currency,
        },
        {
          transaction_id: transactionRow.id,
          account_id: input.toAccountId,
          direction: 'credit',
          amount: String(input.amount),
          currency: input.currency,
        },
      ])
      .returning('*');

    const entries = entryRows
      .map(toEntry)
      .sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'debit' ? -1 : 1));

    const balances = await balancesFor(trx, [input.fromAccountId, input.toAccountId]);

    return {
      transaction: toTransaction(transactionRow),
      entries,
      fromBalance: balances.get(input.fromAccountId) ?? 0,
      toBalance: balances.get(input.toAccountId) ?? 0,
      replayed: false,
    };
  });
}
