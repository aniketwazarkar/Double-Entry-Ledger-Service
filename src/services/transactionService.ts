import db from '../db/knex';
import { Direction, Entry, Transaction } from '../domain/types';
import { NotFoundError } from '../domain/errors';

export interface TransactionWithEntries {
  transaction: Transaction;
  entries: Entry[];
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

/** Debit leg first, then credit, so callers see a stable order on both paths. */
export async function getTransactionWithEntries(id: string): Promise<TransactionWithEntries> {
  const transactionRow = await db<TransactionRow>('transactions').where({ id }).first();

  if (!transactionRow) {
    throw new NotFoundError('Transaction', id);
  }

  const entryRows = await db<EntryRow>('entries')
    .where({ transaction_id: id })
    .orderByRaw("CASE direction WHEN 'debit' THEN 0 ELSE 1 END, id");

  return {
    transaction: toTransaction(transactionRow),
    entries: entryRows.map(toEntry),
  };
}
