import { Router } from 'express';
import db from '../../db/knex';
import { Direction, Entry, Transaction } from '../../domain/types';
import { NotFoundError } from '../../domain/errors';
import { asyncHandler } from '../errorHandler';
import { transactionIdParamsSchema } from '../validation';

export const transactionsRouter = Router();

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
    amount: Number(row.amount),
    currency: row.currency,
    createdAt: row.created_at,
  };
}

transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = transactionIdParamsSchema.parse(req.params);

    const transactionRow = await db<TransactionRow>('transactions').where({ id }).first();
    if (!transactionRow) {
      throw new NotFoundError('Transaction', id);
    }

    const entryRows = await db<EntryRow>('entries')
      .where({ transaction_id: id })
      .orderByRaw("CASE direction WHEN 'debit' THEN 0 ELSE 1 END, id");

    res.status(200).json({
      transaction: toTransaction(transactionRow),
      entries: entryRows.map(toEntry),
    });
  })
);
