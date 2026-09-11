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
 * Validates the request and returns it with account ids canonicalised.
 *
 * Account ids are lowercased here, once, and the normalised copy is what the
 * rest of this module uses. PostgreSQL's `uuid` type compares case-insensitively
 * and always renders back as lowercase, so a caller may legitimately pass
 * `A1B2...` and have it match a row stored as `a1b2...`. Carrying the caller's
 * raw casing any further breaks three things at once:
 *
 *  - the self-transfer guard below, which would let `A1B2...` -> `a1b2...`
 *    through as if the two were different accounts;
 *  - the lock map in `lockAccounts`, which is keyed by the id PostgreSQL
 *    returned (lowercase) and would miss on a raw uppercase lookup, producing a
 *    spurious NotFoundError for a row that was in fact found and locked;
 *  - and most seriously the lock *ordering*, because ASCII sorts every uppercase
 *    letter before every lowercase one. Two concurrent transfers over the same
 *    pair, one spelling an id uppercase and the other lowercase, would sort into
 *    opposite orders and deadlock — the exact failure this service's lock
 *    ordering exists to prevent.
 *
 * Normalising before any of those three consumers run is what keeps them
 * consistent, which is why it happens here rather than at each use site.
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
  // Rejects floats, NaN, Infinity and anything beyond 2^53-1 (which could not be
  // round-tripped through the bigint column as a JS number).
  if (!Number.isSafeInteger(normalized.amount)) {
    throw new ValidationError('amount must be an integer number of minor units');
  }
  if (normalized.amount <= 0) {
    throw new ValidationError('amount must be positive');
  }

  return normalized;
}

/**
 * Locks the two accounts FOR UPDATE, always in ascending id order.
 *
 * Deadlock avoidance rests entirely on this ordering. Two concurrent transfers
 * A->B and B->A touch the same pair of rows; if each locked its own "from"
 * account first they would grab the rows in opposite orders and deadlock. By
 * sorting the ids and issuing the locks as two separate, explicitly ordered
 * statements, every transfer on a given pair requests the lower id first, so the
 * wait-for graph can never contain a cycle.
 *
 * Two statements rather than one `WHERE id IN (...) ORDER BY id FOR UPDATE`: the
 * single-statement form does normally lock in sorted order, but the guarantee is
 * a property of the chosen plan rather than of the SQL, so the ordering is made
 * explicit here instead.
 */
async function lockAccounts(
  trx: Knex.Transaction,
  input: TransferInput
): Promise<Map<string, { id: string; currency: string }>> {
  // Ids arrive already lowercased by normalizeAndValidate, so this sorts
  // canonical spellings and every caller derives the same order for a pair.
  const orderedIds = [input.fromAccountId, input.toAccountId].sort();
  const locked = new Map<string, { id: string; currency: string }>();

  for (const id of orderedIds) {
    const row = await trx('accounts').select('id', 'currency').where({ id }).forUpdate().first();
    if (row) {
      // Keyed by the id we looked up, not by row.id. Both are canonical
      // lowercase here, but keying off the lookup value keeps this map
      // addressable by exactly the ids the caller side uses.
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
  // Boundary validation happens before any connection is taken: a malformed
  // request must never open a database transaction.
  //
  // The result shadows the parameter deliberately: everything below this line
  // sees only the normalised ids, so no use site can accidentally reach for the
  // caller's raw casing.
  const input = normalizeAndValidate(rawInput);

  return db.transaction(async (trx) => {
    const locked = await lockAccounts(trx, input);
    assertAccount(locked, input.fromAccountId, input.currency, 'source');
    assertAccount(locked, input.toAccountId, input.currency, 'destination');

    // Claim the idempotency key. DO NOTHING means a replay returns no row.
    //
    // On the racing path (two concurrent requests, same brand-new key), the
    // loser's INSERT does not return immediately: PostgreSQL's speculative
    // insertion blocks on the winner's transaction id until it commits or
    // aborts. Only then does this statement resolve — as "no row inserted" if
    // the winner committed, or as a successful insert if it rolled back. Under
    // READ COMMITTED (the default here) the following SELECT takes a fresh
    // snapshot, so the winner's row is already visible to it. There is
    // therefore no window in which the insert reports a conflict but the
    // fallback fetch finds nothing.
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
        // Unreachable under READ COMMITTED (see above). Fail loudly rather than
        // silently inventing a second transaction for the same key.
        throw new Error(
          `idempotency key ${input.idempotencyKey} conflicted on insert but could not be read back`
        );
      }

      // Sequential, not Promise.all: a Knex transaction is pinned to one
      // connection, so concurrent queries on it buy nothing and only muddy
      // failure handling.
      const entries = await entriesFor(trx, existing.id);
      // Balances are read now, inside the same locked transaction, so they
      // reflect current state (including transfers made after the original)
      // rather than a stale snapshot from when the original was written.
      const balances = await balancesFor(trx, [input.fromAccountId, input.toAccountId]);

      return {
        transaction: toTransaction(existing),
        entries,
        fromBalance: balances.get(input.fromAccountId) ?? 0,
        toBalance: balances.get(input.toAccountId) ?? 0,
        replayed: true,
      };
    }

    // Exactly one debit (source) and one credit (destination), in one
    // multi-row insert, inside this transaction. The deferred balance-invariant
    // trigger checks the pair at COMMIT.
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
