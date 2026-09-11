import db from '../../src/db/knex';
import { closeDb, truncateAll } from './helpers/db';

async function createAccount(name: string): Promise<string> {
  const [row] = await db('accounts')
    .insert({ name, currency: 'USD', type: 'asset' })
    .returning('id');
  return row.id as string;
}

describe('balance invariant trigger', () => {
  let accountA: string;
  let accountB: string;

  beforeEach(async () => {
    await truncateAll();
    accountA = await createAccount('A');
    accountB = await createAccount('B');
  });

  afterAll(async () => {
    await closeDb();
  });

  it('rejects an unbalanced transaction at COMMIT time, not at INSERT time', async () => {
    let insertSucceeded = false;
    let transactionId: string | undefined;

    await expect(
      db.transaction(async (trx) => {
        const [tx] = await trx('transactions')
          .insert({ idempotency_key: 'unbalanced-1', description: 'bad' })
          .returning('id');
        transactionId = tx.id as string;

        // debit 100 / credit 50 — does not balance
        await trx('entries').insert([
          {
            transaction_id: transactionId,
            account_id: accountA,
            direction: 'debit',
            amount: '100',
            currency: 'USD',
          },
          {
            transaction_id: transactionId,
            account_id: accountB,
            direction: 'credit',
            amount: '50',
            currency: 'USD',
          },
        ]);

        // Deferred constraint trigger: the INSERT statement itself must succeed.
        insertSucceeded = true;
      })
    ).rejects.toThrow(/unbalanced/i);

    expect(insertSucceeded).toBe(true);

    // Nothing was persisted: the whole transaction rolled back.
    const entries = await db('entries').where({ transaction_id: transactionId });
    expect(entries).toHaveLength(0);
    const txs = await db('transactions').where({ idempotency_key: 'unbalanced-1' });
    expect(txs).toHaveLength(0);
  });

  it('rejects a lone single entry with no counterpart', async () => {
    await expect(
      db.transaction(async (trx) => {
        const [tx] = await trx('transactions')
          .insert({ idempotency_key: 'lonely-1' })
          .returning('id');

        await trx('entries').insert({
          transaction_id: tx.id,
          account_id: accountA,
          direction: 'debit',
          amount: '100',
          currency: 'USD',
        });
      })
    ).rejects.toThrow(/unbalanced/i);

    expect(await db('entries')).toHaveLength(0);
  });

  it('rejects entries added across separate statements that leave the total unbalanced', async () => {
    await expect(
      db.transaction(async (trx) => {
        const [tx] = await trx('transactions')
          .insert({ idempotency_key: 'split-statements' })
          .returning('id');

        await trx('entries').insert({
          transaction_id: tx.id,
          account_id: accountA,
          direction: 'debit',
          amount: '100',
          currency: 'USD',
        });
        await trx('entries').insert({
          transaction_id: tx.id,
          account_id: accountB,
          direction: 'credit',
          amount: '70',
          currency: 'USD',
        });
      })
    ).rejects.toThrow(/unbalanced/i);

    expect(await db('entries')).toHaveLength(0);
  });

  it('commits a balanced pair inserted in one multi-row INSERT', async () => {
    const transactionId = await db.transaction(async (trx) => {
      const [tx] = await trx('transactions')
        .insert({ idempotency_key: 'balanced-1', description: 'good' })
        .returning('id');

      await trx('entries').insert([
        {
          transaction_id: tx.id,
          account_id: accountA,
          direction: 'debit',
          amount: '100',
          currency: 'USD',
        },
        {
          transaction_id: tx.id,
          account_id: accountB,
          direction: 'credit',
          amount: '100',
          currency: 'USD',
        },
      ]);

      return tx.id as string;
    });

    const entries = await db('entries')
      .where({ transaction_id: transactionId })
      .orderBy('direction');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.direction)).toEqual(['credit', 'debit']);
    expect(entries.map((e) => String(e.amount))).toEqual(['100', '100']);
  });

  it('commits a balanced multi-leg transaction split across statements', async () => {
    const transactionId = await db.transaction(async (trx) => {
      const [tx] = await trx('transactions')
        .insert({ idempotency_key: 'balanced-multi' })
        .returning('id');

      await trx('entries').insert({
        transaction_id: tx.id,
        account_id: accountA,
        direction: 'debit',
        amount: '100',
        currency: 'USD',
      });
      await trx('entries').insert([
        {
          transaction_id: tx.id,
          account_id: accountB,
          direction: 'credit',
          amount: '60',
          currency: 'USD',
        },
        {
          transaction_id: tx.id,
          account_id: accountB,
          direction: 'credit',
          amount: '40',
          currency: 'USD',
        },
      ]);

      return tx.id as string;
    });

    expect(await db('entries').where({ transaction_id: transactionId })).toHaveLength(3);
  });

  describe('column constraints', () => {
    it('rejects a non-positive amount', async () => {
      await expect(
        db.transaction(async (trx) => {
          const [tx] = await trx('transactions')
            .insert({ idempotency_key: 'zero-amount' })
            .returning('id');
          await trx('entries').insert({
            transaction_id: tx.id,
            account_id: accountA,
            direction: 'debit',
            amount: '0',
            currency: 'USD',
          });
        })
      ).rejects.toThrow(/entries_amount_positive_check|violates check constraint/i);
    });

    it('rejects an invalid direction', async () => {
      await expect(
        db.transaction(async (trx) => {
          const [tx] = await trx('transactions')
            .insert({ idempotency_key: 'bad-direction' })
            .returning('id');
          await trx('entries').insert({
            transaction_id: tx.id,
            account_id: accountA,
            direction: 'sideways',
            amount: '100',
            currency: 'USD',
          });
        })
      ).rejects.toThrow(/entries_direction_check|violates check constraint/i);
    });

    it('rejects a duplicate idempotency key', async () => {
      await db('transactions').insert({ idempotency_key: 'dupe' });
      await expect(db('transactions').insert({ idempotency_key: 'dupe' })).rejects.toThrow(
        /duplicate key|unique/i
      );
    });

    it('rejects an entry referencing a non-existent account', async () => {
      await expect(
        db.transaction(async (trx) => {
          const [tx] = await trx('transactions')
            .insert({ idempotency_key: 'bad-fk' })
            .returning('id');
          await trx('entries').insert({
            transaction_id: tx.id,
            account_id: '00000000-0000-0000-0000-000000000000',
            direction: 'debit',
            amount: '100',
            currency: 'USD',
          });
        })
      ).rejects.toThrow(/foreign key/i);
    });
  });
});
