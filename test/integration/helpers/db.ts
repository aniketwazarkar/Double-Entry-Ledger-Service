import db from '../../../src/db/knex';

export async function truncateAll(): Promise<void> {
  await db.raw('TRUNCATE TABLE entries, transactions, accounts RESTART IDENTITY CASCADE');
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
