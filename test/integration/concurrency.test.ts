import db from '../../src/db/knex';
import * as accountService from '../../src/services/accountService';
import * as transferService from '../../src/services/transferService';
import * as reconciliationService from '../../src/services/reconciliationService';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';

async function makeAccount(name: string): Promise<Account> {
  return accountService.createAccount({ name, currency: 'USD', type: 'asset' });
}

describe('concurrency: the sum(debits) == sum(credits) invariant holds under load', () => {
  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('keeps the ledger balanced when many concurrent transfers race in both directions, some retried under duplicate idempotency keys', async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');

    const uniqueTransferCount = 40;
    const duplicateFactor = 3; // each unique transfer is also retried this many extra times with the same key
    const amount = 7;

    const jobs: Promise<transferService.TransferResult>[] = [];
    for (let i = 0; i < uniqueTransferCount; i++) {
      const [fromId, toId] = i % 2 === 0 ? [a.id, b.id] : [b.id, a.id];
      const key = `concurrent-${i}`;
      for (let retry = 0; retry < duplicateFactor; retry++) {
        jobs.push(
          transferService.transfer({
            idempotencyKey: key,
            fromAccountId: fromId,
            toAccountId: toId,
            amount,
            currency: 'USD',
          })
        );
      }
    }

    // Fire everything concurrently: real contention on the same two accounts,
    // real races on duplicate idempotency keys — not sequential awaits.
    const results = await Promise.all(jobs);

    // 1. Exactly one transaction per unique idempotency key, verified against
    //    actual DB state, not just the resolved promises' claims.
    const uniqueTransactionIds = new Set(results.map((r) => r.transaction.id));
    expect(uniqueTransactionIds.size).toBe(uniqueTransferCount);

    const { count: txnCount } = (await db('transactions').count('id as count').first())!;
    expect(Number(txnCount)).toBe(uniqueTransferCount);

    // 2. Entries: exactly 2 rows per accepted transfer (one debit, one credit),
    //    never 2 * (uniqueTransferCount * duplicateFactor) — proves duplicate
    //    idempotency-key requests never inserted a second movement.
    const { count: entryCount } = (await db('entries').count('id as count').first())!;
    expect(Number(entryCount)).toBe(uniqueTransferCount * 2);

    // 3. The core invariant, checked independently of any per-account balance
    //    logic: sum(debits) === sum(credits) across the whole entries table.
    const reconciliation = await reconciliationService.reconcile();
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.totalDebits).toBe(reconciliation.totalCredits);

    // 4. 20 transfers A->B and 20 transfers B->A, same amount each: net
    //    movement is zero. Confirms the concurrent writes landed correctly,
    //    not just that debits happen to equal credits in aggregate.
    expect(await accountService.getBalance(a.id)).toBe(0);
    expect(await accountService.getBalance(b.id)).toBe(0);
  });

  it('never double-applies a transfer when many identical requests race on the same idempotency key with no client-side serialization', async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');

    const raceCount = 20;
    const jobs = Array.from({ length: raceCount }, () =>
      transferService.transfer({
        idempotencyKey: 'race-key',
        fromAccountId: a.id,
        toAccountId: b.id,
        amount: 100,
        currency: 'USD',
      })
    );

    const results = await Promise.all(jobs);

    const transactionIds = new Set(results.map((r) => r.transaction.id));
    expect(transactionIds.size).toBe(1);

    const replayedCount = results.filter((r) => r.replayed).length;
    expect(replayedCount).toBe(raceCount - 1);

    const { count: entryCount } = (await db('entries').count('id as count').first())!;
    expect(Number(entryCount)).toBe(2);

    expect(await accountService.getBalance(a.id)).toBe(-100);
    expect(await accountService.getBalance(b.id)).toBe(100);

    const reconciliation = await reconciliationService.reconcile();
    expect(reconciliation.balanced).toBe(true);
  });
});
