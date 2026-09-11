import db from '../../src/db/knex';
import * as accountService from '../../src/services/accountService';
import * as transferService from '../../src/services/transferService';
import { CurrencyMismatchError, NotFoundError, ValidationError } from '../../src/domain/errors';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

async function makeAccount(name: string, currency = 'USD'): Promise<Account> {
  return accountService.createAccount({ name, currency, type: 'asset' });
}

/** Independent balance read straight from the DB: SUM(credits) - SUM(debits). */
async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await db.raw(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS balance
       FROM entries WHERE account_id = ?`,
    [accountId]
  );
  return Number(rows[0].balance);
}

describe('transferService.transfer', () => {
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

  describe('happy path', () => {
    it('creates one debit and one credit entry and returns correct balances', async () => {
      const result = await transferService.transfer({
        idempotencyKey: 'k-happy',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 2500,
        currency: 'USD',
        description: 'rent',
      });

      expect(result.replayed).toBe(false);
      expect(result.transaction.id).toEqual(expect.any(String));
      expect(result.transaction.idempotencyKey).toBe('k-happy');
      expect(result.transaction.description).toBe('rent');
      expect(result.transaction.createdAt).toBeInstanceOf(Date);

      expect(result.entries).toHaveLength(2);
      const debit = result.entries.find((e) => e.direction === 'debit')!;
      const credit = result.entries.find((e) => e.direction === 'credit')!;

      expect(debit.accountId).toBe(from.id);
      expect(debit.amount).toBe(2500);
      expect(typeof debit.amount).toBe('number');
      expect(debit.currency).toBe('USD');
      expect(debit.transactionId).toBe(result.transaction.id);
      expect(debit.createdAt).toBeInstanceOf(Date);

      expect(credit.accountId).toBe(to.id);
      expect(credit.amount).toBe(2500);
      expect(typeof credit.amount).toBe('number');

      // balance = SUM(credits) - SUM(debits)
      expect(result.fromBalance).toBe(-2500);
      expect(result.toBalance).toBe(2500);

      expect(await balanceOf(from.id)).toBe(-2500);
      expect(await balanceOf(to.id)).toBe(2500);
    });

    it('accumulates across multiple transfers', async () => {
      await transferService.transfer({
        idempotencyKey: 'k-1',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 100,
        currency: 'USD',
      });
      const second = await transferService.transfer({
        idempotencyKey: 'k-2',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 250,
        currency: 'USD',
      });

      expect(second.fromBalance).toBe(-350);
      expect(second.toBalance).toBe(350);
      expect(await balanceOf(from.id)).toBe(-350);
      expect(await balanceOf(to.id)).toBe(350);
    });

    it('allows a null description when omitted', async () => {
      const result = await transferService.transfer({
        idempotencyKey: 'k-nodesc',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 10,
        currency: 'USD',
      });
      expect(result.transaction.description).toBeNull();
    });

    it('locks accounts in ascending id order regardless of transfer direction', async () => {
      // Two opposite-direction transfers on the same pair must take locks in the
      // same order, otherwise they can deadlock. Capture the emitted SQL.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const locked: string[] = [];
      const listener = (q: { sql: string; bindings: readonly unknown[] }) => {
        if (/from\s+"?accounts"?/i.test(q.sql) && /for\s+update/i.test(q.sql)) {
          // Skip non-id bindings such as knex's `limit 1`.
          locked.push(...q.bindings.map(String).filter((b) => UUID_RE.test(b)));
        }
      };
      db.on('query', listener);
      try {
        await transferService.transfer({
          idempotencyKey: 'lock-a-to-b',
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: 10,
          currency: 'USD',
        });
        const firstOrder = [...locked];
        locked.length = 0;

        await transferService.transfer({
          idempotencyKey: 'lock-b-to-a',
          fromAccountId: to.id,
          toAccountId: from.id,
          amount: 10,
          currency: 'USD',
        });
        const secondOrder = [...locked];

        expect(firstOrder).toHaveLength(2);
        expect(secondOrder).toEqual(firstOrder);
        // and that order is ascending by id
        expect(firstOrder).toEqual([...firstOrder].sort());
      } finally {
        db.off('query', listener);
      }
    });

    it('does not deadlock when opposite-direction transfers run concurrently', async () => {
      const pairs = Array.from({ length: 12 }, (_, i) => i);
      const results = await Promise.all(
        pairs.flatMap((i) => [
          transferService.transfer({
            idempotencyKey: `conc-fwd-${i}`,
            fromAccountId: from.id,
            toAccountId: to.id,
            amount: 10,
            currency: 'USD',
          }),
          transferService.transfer({
            idempotencyKey: `conc-rev-${i}`,
            fromAccountId: to.id,
            toAccountId: from.id,
            amount: 10,
            currency: 'USD',
          }),
        ])
      );

      expect(results).toHaveLength(24);
      // Equal numbers each way, so both accounts net to zero.
      expect(await balanceOf(from.id)).toBe(0);
      expect(await balanceOf(to.id)).toBe(0);
      expect(await db('entries')).toHaveLength(48);
    });
  });

  describe('idempotency', () => {
    it('replays the original transaction without moving money twice', async () => {
      const first = await transferService.transfer({
        idempotencyKey: 'k-replay',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 700,
        currency: 'USD',
        description: 'original',
      });

      const replay = await transferService.transfer({
        idempotencyKey: 'k-replay',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 700,
        currency: 'USD',
        description: 'original',
      });

      expect(replay.replayed).toBe(true);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(replay.transaction.description).toBe('original');
      expect(replay.entries).toHaveLength(2);
      expect(replay.entries.map((e) => e.id).sort()).toEqual(
        first.entries.map((e) => e.id).sort()
      );

      // Money moved exactly once.
      expect(replay.fromBalance).toBe(-700);
      expect(replay.toBalance).toBe(700);
      expect(await balanceOf(from.id)).toBe(-700);
      expect(await balanceOf(to.id)).toBe(700);
      expect(await db('entries')).toHaveLength(2);
      expect(await db('transactions')).toHaveLength(1);
    });

    it('returns balances current as of the replay, not as of the original', async () => {
      const first = await transferService.transfer({
        idempotencyKey: 'k-replay-2',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 100,
        currency: 'USD',
      });
      expect(first.toBalance).toBe(100);

      // A later, unrelated transfer changes the balances.
      await transferService.transfer({
        idempotencyKey: 'k-other',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 50,
        currency: 'USD',
      });

      const replay = await transferService.transfer({
        idempotencyKey: 'k-replay-2',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 100,
        currency: 'USD',
      });

      expect(replay.replayed).toBe(true);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(replay.entries).toHaveLength(2);
      expect(replay.fromBalance).toBe(-150);
      expect(replay.toBalance).toBe(150);
    });

    it('creates exactly one transaction when the same new key is used concurrently', async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          transferService.transfer({
            idempotencyKey: 'k-race',
            fromAccountId: from.id,
            toAccountId: to.id,
            amount: 42,
            currency: 'USD',
          })
        )
      );

      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(rejected).toEqual([]);

      const fulfilled = settled as PromiseFulfilledResult<transferService.TransferResult>[];
      const ids = new Set(fulfilled.map((s) => s.value.transaction.id));
      expect(ids.size).toBe(1);
      expect(fulfilled.filter((s) => !s.value.replayed)).toHaveLength(1);

      expect(await db('transactions')).toHaveLength(1);
      expect(await db('entries')).toHaveLength(2);
      expect(await balanceOf(from.id)).toBe(-42);
      expect(await balanceOf(to.id)).toBe(42);
    });

    it('handles a same-key race on disjoint account pairs, where row locks do not serialise', async () => {
      // The previous test races on one account pair, so the FOR UPDATE locks
      // already serialise the contenders and the ON CONFLICT path is never
      // genuinely concurrent. Here each contender locks a *different* pair, so
      // nothing serialises them before the INSERT — this is what actually
      // exercises PostgreSQL's speculative-insertion wait and the fallback
      // fetch. The risk being probed: a loser whose INSERT reports a conflict
      // but whose follow-up SELECT cannot yet see the winner's uncommitted row.
      const pairs = await Promise.all(
        Array.from({ length: 6 }, async (_unused, i) => ({
          a: await makeAccount(`race-a-${i}`),
          b: await makeAccount(`race-b-${i}`),
        }))
      );

      const settled = await Promise.allSettled(
        pairs.map((p) =>
          transferService.transfer({
            idempotencyKey: 'k-race-disjoint',
            fromAccountId: p.a.id,
            toAccountId: p.b.id,
            amount: 99,
            currency: 'USD',
          })
        )
      );

      const reasons = settled
        .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
        .map((s) => String(s.reason));
      expect(reasons).toEqual([]);

      const fulfilled = settled as PromiseFulfilledResult<transferService.TransferResult>[];
      expect(new Set(fulfilled.map((s) => s.value.transaction.id)).size).toBe(1);
      expect(fulfilled.filter((s) => !s.value.replayed)).toHaveLength(1);

      // Exactly one pair moved money; every other pair replayed and stayed flat.
      expect(await db('transactions').where({ idempotency_key: 'k-race-disjoint' })).toHaveLength(
        1
      );
      expect(await db('entries')).toHaveLength(2);
      const moved = await Promise.all(
        pairs.map(async (p) => (await balanceOf(p.b.id)) === 99)
      );
      expect(moved.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('validation', () => {
    const base = () => ({
      idempotencyKey: 'k-val',
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 100,
      currency: 'USD',
    });

    it.each([
      ['zero', 0],
      ['negative', -100],
      ['fractional', 10.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects a %s amount with ValidationError', async (_label, amount) => {
      await expect(transferService.transfer({ ...base(), amount })).rejects.toThrow(
        ValidationError
      );
    });

    it('rejects a missing idempotency key with ValidationError', async () => {
      await expect(transferService.transfer({ ...base(), idempotencyKey: '' })).rejects.toThrow(
        ValidationError
      );
    });

    it('rejects a self-transfer with ValidationError', async () => {
      await expect(
        transferService.transfer({ ...base(), toAccountId: from.id })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a missing currency with ValidationError', async () => {
      await expect(transferService.transfer({ ...base(), currency: '' })).rejects.toThrow(
        ValidationError
      );
    });

    it('does no database work when validation fails', async () => {
      await expect(transferService.transfer({ ...base(), amount: -1 })).rejects.toThrow(
        ValidationError
      );
      expect(await db('transactions')).toHaveLength(0);
      expect(await db('entries')).toHaveLength(0);
    });
  });

  describe('accounts and currency', () => {
    it('rejects an unknown from-account with NotFoundError', async () => {
      await expect(
        transferService.transfer({
          idempotencyKey: 'k-missing-from',
          fromAccountId: MISSING_ID,
          toAccountId: to.id,
          amount: 100,
          currency: 'USD',
        })
      ).rejects.toThrow(NotFoundError);
      expect(await db('transactions')).toHaveLength(0);
    });

    it('rejects an unknown to-account with NotFoundError', async () => {
      await expect(
        transferService.transfer({
          idempotencyKey: 'k-missing-to',
          fromAccountId: from.id,
          toAccountId: MISSING_ID,
          amount: 100,
          currency: 'USD',
        })
      ).rejects.toThrow(NotFoundError);
      expect(await db('transactions')).toHaveLength(0);
    });

    it('rejects when the from-account currency differs from the request', async () => {
      const eur = await makeAccount('Eur', 'EUR');
      await expect(
        transferService.transfer({
          idempotencyKey: 'k-cur-from',
          fromAccountId: eur.id,
          toAccountId: to.id,
          amount: 100,
          currency: 'USD',
        })
      ).rejects.toThrow(CurrencyMismatchError);
      expect(await db('entries')).toHaveLength(0);
    });

    it('rejects when the to-account currency differs from the request', async () => {
      const eur = await makeAccount('Eur', 'EUR');
      await expect(
        transferService.transfer({
          idempotencyKey: 'k-cur-to',
          fromAccountId: from.id,
          toAccountId: eur.id,
          amount: 100,
          currency: 'USD',
        })
      ).rejects.toThrow(CurrencyMismatchError);
      expect(await db('entries')).toHaveLength(0);
    });

    it('rejects a cross-currency transfer even though it would net to zero', async () => {
      // Both accounts EUR, request says USD: the DB trigger would happily accept
      // debit 100 / credit 100, so only application-level validation catches this.
      const eurA = await makeAccount('EurA', 'EUR');
      const eurB = await makeAccount('EurB', 'EUR');
      await expect(
        transferService.transfer({
          idempotencyKey: 'k-cur-both',
          fromAccountId: eurA.id,
          toAccountId: eurB.id,
          amount: 100,
          currency: 'USD',
        })
      ).rejects.toThrow(CurrencyMismatchError);
      expect(await db('entries')).toHaveLength(0);
    });

    it('permits a transfer between two matching non-USD accounts', async () => {
      const eurA = await makeAccount('EurA', 'EUR');
      const eurB = await makeAccount('EurB', 'EUR');
      const result = await transferService.transfer({
        idempotencyKey: 'k-eur',
        fromAccountId: eurA.id,
        toAccountId: eurB.id,
        amount: 100,
        currency: 'EUR',
      });
      expect(result.entries.every((e) => e.currency === 'EUR')).toBe(true);
      expect(result.toBalance).toBe(100);
    });
  });
});
