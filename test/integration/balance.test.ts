import db from '../../src/db/knex';
import * as accountService from '../../src/services/accountService';
import * as transferService from '../../src/services/transferService';
import { NotFoundError } from '../../src/domain/errors';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

async function makeAccount(name: string, currency = 'USD'): Promise<Account> {
  return accountService.createAccount({ name, currency, type: 'asset' });
}

/**
 * Polls the DB's own clock (not the test host's — see the clock-skew note
 * further down) until it has moved into a later millisecond than `after`.
 * Used to guarantee two DB writes land in genuinely different milliseconds,
 * since Postgres/Docker can otherwise complete both within the same one.
 */
async function waitForClockToAdvancePast(after: Date, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.raw('SELECT now() AS now');
    if ((rows[0].now as Date).getTime() > after.getTime()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`DB clock did not advance past ${after.toISOString()} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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

    // getBalance's asOf boundary is inclusive over the *entire millisecond*
    // of `cutoff` (a JS Date can't express Postgres's microsecond
    // precision, so the comparison is widened to cover it — see
    // accountService.getBalance). That means this test only proves
    // exclusion if the second transfer lands in a *later* millisecond than
    // `cutoff`; on a fast local Postgres/Docker setup two inserts can easily
    // land in the same millisecond, which would make the boundary
    // incorrectly include the second transfer too. Poll until the DB's
    // clock has actually advanced past `cutoff`'s millisecond before firing
    // the second transfer, so the test exercises real exclusion rather than
    // hoping for a gap.
    await waitForClockToAdvancePast(cutoff);

    const after = await transferService.transfer({
      idempotencyKey: 'k-after',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 300,
      currency: 'USD',
    });

    // Fail fast with a clear message rather than silently flaking if the two
    // transfers still landed in the same millisecond despite the wait above.
    const afterCreatedAt = after.entries[0].createdAt;
    if (afterCreatedAt.getTime() <= cutoff.getTime()) {
      throw new Error(
        `test precondition violated: second transfer's created_at (${afterCreatedAt.toISOString()}) ` +
          `did not land after the cutoff (${cutoff.toISOString()}); the exclusion assertion below ` +
          `would be meaningless`
      );
    }

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
