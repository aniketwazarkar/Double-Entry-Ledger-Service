import db from '../db/knex';
import { Account, AccountType } from '../domain/types';
import { NotFoundError, ValidationError } from '../domain/errors';

interface CreateAccountInput {
  name: string;
  currency: string;
  type: AccountType;
}

const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity'];

/**
 * Mirrors transferService's boundary validation: the API layer already checks
 * these with zod, but this service is also called directly from scripts (e.g.
 * seed-dev-data.ts), so it cannot assume a well-formed input has arrived.
 */
function validateCreateAccountInput(input: CreateAccountInput): CreateAccountInput {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ValidationError('name is required');
  }
  if (typeof input.currency !== 'string' || input.currency.trim() === '') {
    throw new ValidationError('currency is required');
  }
  if (!ACCOUNT_TYPES.includes(input.type)) {
    throw new ValidationError(`type must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  }

  return input;
}

function validateAccountId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('id is required');
  }
}

interface AccountRow {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  created_at: Date;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    type: row.type,
    createdAt: row.created_at,
  };
}

export async function createAccount(rawInput: CreateAccountInput): Promise<Account> {
  const input = validateCreateAccountInput(rawInput);

  const [row] = await db<AccountRow>('accounts')
    .insert({
      name: input.name.trim(),
      currency: input.currency.trim(),
      type: input.type,
    })
    .returning('*');

  return toAccount(row);
}

export async function getAllAccounts(): Promise<Account[]> {
  const rows = await db<AccountRow>('accounts').orderBy('created_at', 'asc');

  return rows.map(toAccount);
}

export async function getAccount(id: string): Promise<Account> {
  validateAccountId(id);

  const row = await db<AccountRow>('accounts').where({ id }).first();

  if (!row) {
    throw new NotFoundError('Account', id);
  }

  return toAccount(row);
}

/**
 * balance = SUM(credit amounts) - SUM(debit amounts), optionally restricted to
 * entries created at or before `asOf` (inclusive).
 */
export async function getBalance(id: string, asOf?: Date): Promise<number> {
  validateAccountId(id);
  if (asOf !== undefined && (!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))) {
    throw new ValidationError('asOf must be a valid date');
  }

  const account = await db<AccountRow>('accounts').where({ id }).first();

  if (!account) {
    throw new NotFoundError('Account', id);
  }

  const query = db('entries').where({ account_id: id });
  if (asOf) {
    query.where('created_at', '<', new Date(asOf.getTime() + 1));
  }

  const row = await query
    .select(
      db.raw(
        `COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS balance`
      )
    )
    .first<{ balance: string }>();

  // bigint sum arrives as a string from pg; convert explicitly.
  return Number(row?.balance ?? 0);
}
