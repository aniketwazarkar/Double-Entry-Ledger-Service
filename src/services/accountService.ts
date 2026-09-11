import db from '../db/knex';
import { Account, AccountType } from '../domain/types';
import { NotFoundError } from '../domain/errors';

interface CreateAccountInput {
  name: string;
  currency: string;
  type: AccountType;
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

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const [row] = await db<AccountRow>('accounts')
    .insert({
      name: input.name,
      currency: input.currency,
      type: input.type,
    })
    .returning('*');

  return toAccount(row);
}

export async function getAccount(id: string): Promise<Account> {
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
  const account = await db<AccountRow>('accounts').where({ id }).first();

  if (!account) {
    throw new NotFoundError('Account', id);
  }

  const query = db('entries').where({ account_id: id });
  if (asOf) {
    // `created_at` is a Postgres timestamptz with microsecond precision, but a
    // JS Date only carries milliseconds, so `asOf` is always a truncated-down
    // representation of any real timestamp that shares its millisecond. Using
    // a plain `<=` would then exclude a row created in the same millisecond as
    // `asOf` whenever its microsecond remainder is non-zero (e.g. an entry's
    // own `createdAt`, echoed straight back as `asOf`, would fail to match
    // itself). Comparing against the start of the *next* millisecond makes the
    // whole millisecond of `asOf` inclusive, which is the intended boundary.
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
