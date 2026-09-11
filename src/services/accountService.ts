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
