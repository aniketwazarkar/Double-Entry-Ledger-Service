import db from '../../src/db/knex';
import * as accountService from '../../src/services/accountService';
import * as statementService from '../../src/services/statementService';
import * as transferService from '../../src/services/transferService';
import { NotFoundError, ValidationError } from '../../src/domain/errors';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';
import type { StatementRow } from '../../src/services/statementService';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

async function makeAccount(name: string, currency = 'USD'): Promise<Account> {
  return accountService.createAccount({ name, currency, type: 'asset' });
}

/**
 * Writes a balanced debit/credit pair directly, with `created_at` pinned to an
 * exact Postgres timestamp string (microsecond precision, which a JS `Date`
 * cannot express). Used to build boundary fixtures that `transferService`
 * cannot produce on demand: several entries sharing one millisecond but
 * differing in their microsecond remainder.
 *
 * The balance-invariant trigger is DEFERRABLE INITIALLY DEFERRED, so inserting
 * both legs inside one transaction satisfies it at COMMIT.
 */
async function insertPairAt(
  fromId: string,
  toId: string,
  amount: number,
  createdAtSql: string,
  currency = 'USD',
): Promise<void> {
  await db.transaction(async (trx) => {
    const [tx] = await trx('transactions')
      .insert({
        idempotency_key: `fixture-${createdAtSql}-${Math.random()}`,
        description: null,
      })
      .returning('id');

    await trx('entries').insert([
      {
        transaction_id: tx.id,
        account_id: fromId,
        direction: 'debit',
        amount: String(amount),
        currency,
        created_at: db.raw('?::timestamptz', [createdAtSql]),
      },
      {
        transaction_id: tx.id,
        account_id: toId,
        direction: 'credit',
        amount: String(amount),
        currency,
        created_at: db.raw('?::timestamptz', [createdAtSql]),
      },
    ]);
  });
}

/** Walks every page of a statement and returns the concatenated rows. */
async function readAllPages(
  accountId: string,
  limit: number,
): Promise<{ rows: StatementRow[]; pageCount: number }> {
  const rows: StatementRow[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  for (;;) {
    const page: statementService.StatementPage = await statementService.getStatement(accountId, {
      limit,
      cursor,
    });
    pageCount += 1;
    rows.push(...page.rows);

    if (page.nextCursor === null) {
      return { rows, pageCount };
    }
    cursor = page.nextCursor;

    if (pageCount > 500) {
      throw new Error('pagination did not terminate');
    }
  }
}

/**
 * Independently recomputes the expected running balance sequence for an
 * account, straight from the table, without going through getStatement.
 */
async function expectedRunningBalances(accountId: string): Promise<number[]> {
  const entries = await db('entries')
    .where({ account_id: accountId })
    .orderBy([{ column: 'created_at' }, { column: 'id' }])
    .select('direction', 'amount');

  let balance = 0;
  return entries.map((e: { direction: string; amount: string }) => {
    balance += e.direction === 'credit' ? Number(e.amount) : -Number(e.amount);
    return balance;
  });
}

describe('statementService.getStatement', () => {
  let a: Account;
  let b: Account;

  beforeEach(async () => {
    await truncateAll();
    a = await makeAccount('A');
    b = await makeAccount('B');
  });

  afterAll(async () => {
    await closeDb();
  });

  it('throws NotFoundError for a nonexistent account', async () => {
    await expect(statementService.getStatement(MISSING_ID)).rejects.toThrow(NotFoundError);
  });

  it('returns an empty page with a null cursor for an account with no entries', async () => {
    const page = await statementService.getStatement(a.id);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns entries chronologically with a correct running balance at each step', async () => {
    // a: -100, then +250, then -30  =>  running: -100, 150, 120
    await transferService.transfer({
      idempotencyKey: 's1',
      fromAccountId: a.id,
      toAccountId: b.id,
      amount: 100,
      currency: 'USD',
    });
    await transferService.transfer({
      idempotencyKey: 's2',
      fromAccountId: b.id,
      toAccountId: a.id,
      amount: 250,
      currency: 'USD',
    });
    await transferService.transfer({
      idempotencyKey: 's3',
      fromAccountId: a.id,
      toAccountId: b.id,
      amount: 30,
      currency: 'USD',
    });

    const page = await statementService.getStatement(a.id);

    expect(page.nextCursor).toBeNull();
    expect(page.rows.map((r) => r.entry.direction)).toEqual(['debit', 'credit', 'debit']);
    expect(page.rows.map((r) => r.entry.amount)).toEqual([100, 250, 30]);
    expect(page.rows.map((r) => r.runningBalance)).toEqual([-100, 150, 120]);

    // amount must be a number, not the string pg hands back for bigint.
    expect(typeof page.rows[0].entry.amount).toBe('number');
    expect(page.rows[0].entry.createdAt).toBeInstanceOf(Date);
    expect(page.rows[0].entry.accountId).toBe(a.id);

    // The last row's running balance is the account's balance.
    await expect(accountService.getBalance(a.id)).resolves.toBe(120);
  });

  it('excludes entries belonging to other accounts', async () => {
    await transferService.transfer({
      idempotencyKey: 'other',
      fromAccountId: a.id,
      toAccountId: b.id,
      amount: 42,
      currency: 'USD',
    });

    const page = await statementService.getStatement(a.id);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].entry.accountId).toBe(a.id);
    expect(page.rows[0].runningBalance).toBe(-42);
  });

  it('paginates with a small limit, continuing the running balance across page boundaries', async () => {
    const amounts = [10, 20, 30, 40, 50, 60, 70];
    for (const [i, amount] of amounts.entries()) {
      await transferService.transfer({
        idempotencyKey: `p${i}`,
        // alternate direction so the running balance is not monotonic
        fromAccountId: i % 2 === 0 ? a.id : b.id,
        toAccountId: i % 2 === 0 ? b.id : a.id,
        amount,
        currency: 'USD',
      });
    }

    const expected = await expectedRunningBalances(a.id);
    expect(expected).toHaveLength(amounts.length);

    const { rows, pageCount } = await readAllPages(a.id, 2);

    expect(pageCount).toBe(4); // 2 + 2 + 2 + 1
    expect(rows).toHaveLength(amounts.length);
    // No gaps and no duplicates across the boundaries.
    expect(new Set(rows.map((r) => r.entry.id)).size).toBe(amounts.length);
    expect(rows.map((r) => r.entry.amount)).toEqual(amounts);
    // Running balance is cumulative from the very start, not per-page.
    expect(rows.map((r) => r.runningBalance)).toEqual(expected);
  });

  it('reports a nextCursor only while more rows remain', async () => {
    for (let i = 0; i < 3; i += 1) {
      await transferService.transfer({
        idempotencyKey: `c${i}`,
        fromAccountId: a.id,
        toAccountId: b.id,
        amount: 5,
        currency: 'USD',
      });
    }

    const first = await statementService.getStatement(a.id, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');

    const second = await statementService.getStatement(a.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const exact = await statementService.getStatement(a.id, { limit: 3 });
    expect(exact.rows).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();
  });

  it('does not skip or duplicate rows whose timestamps differ only below millisecond precision', async () => {
    const base = '2026-01-01 00:00:00.000';
    const micros = ['100', '200', '300', '400', '500', '600'];
    for (const [i, us] of micros.entries()) {
      await insertPairAt(a.id, b.id, (i + 1) * 10, `${base}${us}+00`);
    }

    const expected = await expectedRunningBalances(a.id);

    const { rows } = await readAllPages(a.id, 1);

    expect(rows).toHaveLength(micros.length);
    expect(new Set(rows.map((r) => r.entry.id)).size).toBe(micros.length);
    expect(rows.map((r) => r.entry.amount)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(rows.map((r) => r.runningBalance)).toEqual(expected);

    const millis = new Set(rows.map((r) => r.entry.createdAt.getTime()));
    expect(millis.size).toBe(1);
  });

  it('orders deterministically by id when created_at is exactly equal', async () => {
    const ts = '2026-02-02 00:00:00.500000+00';
    for (let i = 0; i < 3; i += 1) {
      await insertPairAt(a.id, b.id, (i + 1) * 100, ts);
    }

    const full = await statementService.getStatement(a.id, { limit: 10 });
    expect(full.rows).toHaveLength(3);
    const ids = full.rows.map((r) => r.entry.id);
    expect([...ids].sort()).toEqual(ids); // ascending id order

    const { rows } = await readAllPages(a.id, 1);
    expect(rows.map((r) => r.entry.id)).toEqual(ids);
    expect(rows.map((r) => r.runningBalance)).toEqual(full.rows.map((r) => r.runningBalance));
  });

  it('keeps an already-issued cursor stable when new entries are appended', async () => {
    for (let i = 0; i < 4; i += 1) {
      await transferService.transfer({
        idempotencyKey: `stable${i}`,
        fromAccountId: a.id,
        toAccountId: b.id,
        amount: 100,
        currency: 'USD',
      });
    }

    const first = await statementService.getStatement(a.id, { limit: 2 });
    expect(first.rows.map((r) => r.runningBalance)).toEqual([-100, -200]);
    expect(first.nextCursor).not.toBeNull();

    // A new entry lands *after* the cursor while the client is paging.
    await transferService.transfer({
      idempotencyKey: 'stable-late',
      fromAccountId: a.id,
      toAccountId: b.id,
      amount: 100,
      currency: 'USD',
    });

    const second = await statementService.getStatement(a.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    
    expect(second.rows.map((r) => r.entry.id)).not.toEqual(
      expect.arrayContaining(first.rows.map((r) => r.entry.id)),
    );
    expect(second.rows.map((r) => r.runningBalance)).toEqual([-300, -400]);
    expect(second.nextCursor).not.toBeNull();

    const third = await statementService.getStatement(a.id, {
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(third.rows.map((r) => r.runningBalance)).toEqual([-500]);
    expect(third.nextCursor).toBeNull();
  });

  it('rejects a structurally valid cursor carrying nonsense values', async () => {
    const nonsense = (createdAt: string, id: string): string =>
      Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');

    // Both halves nonsense.
    await expect(
      statementService.getStatement(a.id, { cursor: nonsense('banana', 'not-a-uuid') }),
    ).rejects.toThrow(ValidationError);

    // Valid timestamp, bad uuid.
    await expect(
      statementService.getStatement(a.id, {
        cursor: nonsense('2026-01-01 00:00:00.000400+00', 'not-a-uuid'),
      }),
    ).rejects.toThrow(ValidationError);

    // Valid uuid, bad timestamp.
    await expect(
      statementService.getStatement(a.id, { cursor: nonsense('banana', MISSING_ID) }),
    ).rejects.toThrow(ValidationError);

    // A well-formed cursor whose values simply match nothing is NOT an error —
    // it is a legitimate position past the end of an empty account.
    const valid = nonsense('2026-01-01 00:00:00.000400+00', MISSING_ID);
    const page = await statementService.getStatement(a.id, { cursor: valid });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    await expect(statementService.getStatement(a.id, { cursor: 'not-a-cursor' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an invalid limit', async () => {
    await expect(statementService.getStatement(a.id, { limit: 0 })).rejects.toThrow(
      ValidationError,
    );
    await expect(statementService.getStatement(a.id, { limit: -1 })).rejects.toThrow(
      ValidationError,
    );
    await expect(statementService.getStatement(a.id, { limit: 1.5 })).rejects.toThrow(
      ValidationError,
    );
    await expect(statementService.getStatement(a.id, { limit: 10_000 })).rejects.toThrow(
      ValidationError,
    );
  });
});
