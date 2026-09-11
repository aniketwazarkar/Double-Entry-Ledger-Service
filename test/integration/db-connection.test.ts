import db from '../../src/db/knex';
import { closeDb } from './helpers/db';

describe('database connection', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('executes a trivial query against Postgres', async () => {
    const result = await db.raw('SELECT 1 as value');
    expect(result.rows[0].value).toBe(1);
  });
});
