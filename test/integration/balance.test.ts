import * as accountService from '../../src/services/accountService';
import * as transferService from '../../src/services/transferService';
import { NotFoundError } from '../../src/domain/errors';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

async function makeAccount(name: string, currency = 'USD'): Promise<Account> {
  return accountService.createAccount({ name, currency, type: 'asset' });
}

describe('accountService.getBalance', () => {
  let from: Account;
  let to: Account;

  beforeEach(async () => {
    await truncateAll();
    from = await makeAccount('From');
    to = await makeAccount('To');
  });

  afterAll(async () => {
    await closeDb();
  });

  it('returns 0 for a fresh account with no entries', async () => {
    await expect(accountService.getBalance(from.id)).resolves.toBe(0);
  });

  it('reflects transfers in and out correctly', async () => {
    await transferService.transfer({
      idempotencyKey: 'k1',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 1000,
      currency: 'USD',
    });

    await expect(accountService.getBalance(from.id)).resolves.toBe(-1000);
    await expect(accountService.getBalance(to.id)).resolves.toBe(1000);

    await transferService.transfer({
      idempotencyKey: 'k2',
      fromAccountId: to.id,
      toAccountId: from.id,
      amount: 400,
      currency: 'USD',
    });

    await expect(accountService.getBalance(from.id)).resolves.toBe(-600);
    await expect(accountService.getBalance(to.id)).resolves.toBe(600);
  });

  it('excludes entries created after the asOf boundary and includes ones at/before it', async () => {
    const before = await transferService.transfer({
      idempotencyKey: 'k-before',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 500,
      currency: 'USD',
    });

    // Derived from the DB's own clock (the entry's stored `created_at`)
    // rather than the test host's clock, since the two can be skewed by a
    // small but non-negligible amount when Postgres runs in Docker.
    const cutoff = before.entries[0].createdAt;

    await transferService.transfer({
      idempotencyKey: 'k-after',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 300,
      currency: 'USD',
    });

    // asOf before the second transfer excludes it.
    await expect(accountService.getBalance(to.id, cutoff)).resolves.toBe(500);
    // No asOf includes everything.
    await expect(accountService.getBalance(to.id)).resolves.toBe(800);
  });

  it('asOf boundary is inclusive of entries created exactly at that timestamp', async () => {
    const result = await transferService.transfer({
      idempotencyKey: 'k-exact',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 250,
      currency: 'USD',
    });

    const exactTimestamp = result.entries[0].createdAt;

    await expect(accountService.getBalance(to.id, exactTimestamp)).resolves.toBe(250);
  });

  it('throws NotFoundError for a nonexistent account', async () => {
    await expect(accountService.getBalance(MISSING_ID)).rejects.toThrow(NotFoundError);
  });
});
