import request from 'supertest';
import { app } from '../../src/api/app';
import { closeDb, truncateAll } from './helpers/db';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

async function createAccount(overrides: Partial<{ name: string; currency: string; type: string }> = {}) {
  const res = await request(app)
    .post('/accounts')
    .send({ name: 'Acct', currency: 'USD', type: 'asset', ...overrides });
  return res;
}

describe('HTTP API', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('POST /accounts', () => {
    it('creates an account and returns 201', async () => {
      const res = await createAccount({ name: 'Checking', currency: 'USD', type: 'asset' });

      expect(res.status).toBe(201);
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.name).toBe('Checking');
      expect(res.body.currency).toBe('USD');
      expect(res.body.type).toBe('asset');
    });

    it('rejects an unknown account type with 400 ValidationError', async () => {
      const res = await createAccount({ type: 'bogus' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it('rejects a missing name with 400 ValidationError', async () => {
      const res = await request(app).post('/accounts').send({ currency: 'USD', type: 'asset' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });
  });

  describe('GET /accounts/:id', () => {
    it('returns the account', async () => {
      const created = await createAccount({ name: 'Savings' });
      const res = await request(app).get(`/accounts/${created.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Savings');
    });

    it('returns 404 NotFoundError for an unknown id', async () => {
      const res = await request(app).get(`/accounts/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });

    it('returns 400 ValidationError for a non-UUID id', async () => {
      const res = await request(app).get('/accounts/not-a-uuid');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });
  });

  describe('GET /accounts/:id/balance', () => {
    it('returns 0 for a fresh account', async () => {
      const created = await createAccount();
      const res = await request(app).get(`/accounts/${created.body.id}/balance`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accountId: created.body.id, balance: 0 });
    });

    it('returns 404 for an unknown account', async () => {
      const res = await request(app).get(`/accounts/${MISSING_ID}/balance`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });

    it('accepts an asOf query parameter', async () => {
      const created = await createAccount();
      const res = await request(app)
        .get(`/accounts/${created.body.id}/balance`)
        .query({ asOf: new Date().toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(0);
    });
  });

  describe('GET /accounts/:id/statement', () => {
    it('returns an empty page for a fresh account', async () => {
      const created = await createAccount();
      const res = await request(app).get(`/accounts/${created.body.id}/statement`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ rows: [], nextCursor: null });
    });

    it('returns 404 for an unknown account', async () => {
      const res = await request(app).get(`/accounts/${MISSING_ID}/statement`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });

    it('returns 400 ValidationError for a malformed cursor', async () => {
      const created = await createAccount();
      const res = await request(app)
        .get(`/accounts/${created.body.id}/statement`)
        .query({ cursor: 'not-a-valid-cursor!!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });
  });

  describe('POST /transfers', () => {
    it('runs the full create-accounts -> transfer -> balance -> statement flow', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const transferRes = await request(app)
        .post('/transfers')
        .send({
          idempotencyKey: 'flow-key-1',
          fromAccountId: from.body.id,
          toAccountId: to.body.id,
          amount: 1000,
          currency: 'USD',
          description: 'test transfer',
        });

      expect(transferRes.status).toBe(201);
      expect(transferRes.body.replayed).toBe(false);
      expect(transferRes.body.transaction.id).toEqual(expect.any(String));
      expect(transferRes.body.entries).toHaveLength(2);
      expect(transferRes.body.fromBalance).toBe(-1000);
      expect(transferRes.body.toBalance).toBe(1000);

      const fromBalanceRes = await request(app).get(`/accounts/${from.body.id}/balance`);
      expect(fromBalanceRes.body.balance).toBe(-1000);

      const toBalanceRes = await request(app).get(`/accounts/${to.body.id}/balance`);
      expect(toBalanceRes.body.balance).toBe(1000);

      const statementRes = await request(app).get(`/accounts/${to.body.id}/statement`);
      expect(statementRes.status).toBe(200);
      expect(statementRes.body.rows).toHaveLength(1);
      expect(statementRes.body.rows[0].runningBalance).toBe(1000);
    });

    it('returns 200 (not 201) with the same transaction id on a replayed idempotency key', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const payload = {
        idempotencyKey: 'replay-key-1',
        fromAccountId: from.body.id,
        toAccountId: to.body.id,
        amount: 500,
        currency: 'USD',
      };

      const first = await request(app).post('/transfers').send(payload);
      expect(first.status).toBe(201);

      const second = await request(app).post('/transfers').send(payload);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.transaction.id).toBe(first.body.transaction.id);
    });

    it('rejects a non-integer amount with 400 ValidationError', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const res = await request(app)
        .post('/transfers')
        .send({
          idempotencyKey: 'bad-amount',
          fromAccountId: from.body.id,
          toAccountId: to.body.id,
          amount: 10.5,
          currency: 'USD',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('rejects a non-positive amount with 400 ValidationError', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const res = await request(app)
        .post('/transfers')
        .send({
          idempotencyKey: 'bad-amount-2',
          fromAccountId: from.body.id,
          toAccountId: to.body.id,
          amount: 0,
          currency: 'USD',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('rejects a missing idempotencyKey with 400 ValidationError', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const res = await request(app).post('/transfers').send({
        fromAccountId: from.body.id,
        toAccountId: to.body.id,
        amount: 100,
        currency: 'USD',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('rejects a non-UUID account id with 400 ValidationError', async () => {
      const to = await createAccount({ name: 'To' });

      const res = await request(app).post('/transfers').send({
        idempotencyKey: 'bad-uuid',
        fromAccountId: 'not-a-uuid',
        toAccountId: to.body.id,
        amount: 100,
        currency: 'USD',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('returns 404 NotFoundError for an unknown account', async () => {
      const to = await createAccount({ name: 'To' });

      const res = await request(app).post('/transfers').send({
        idempotencyKey: 'unknown-account',
        fromAccountId: MISSING_ID,
        toAccountId: to.body.id,
        amount: 100,
        currency: 'USD',
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });

    it('returns 400 CurrencyMismatchError for mismatched currencies', async () => {
      const from = await createAccount({ name: 'From', currency: 'USD' });
      const to = await createAccount({ name: 'To', currency: 'EUR' });

      const res = await request(app).post('/transfers').send({
        idempotencyKey: 'currency-mismatch',
        fromAccountId: from.body.id,
        toAccountId: to.body.id,
        amount: 100,
        currency: 'USD',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CurrencyMismatchError');
    });
  });

  describe('GET /transactions/:id', () => {
    it('returns the transaction with its entries', async () => {
      const from = await createAccount({ name: 'From' });
      const to = await createAccount({ name: 'To' });

      const transferRes = await request(app).post('/transfers').send({
        idempotencyKey: 'tx-lookup',
        fromAccountId: from.body.id,
        toAccountId: to.body.id,
        amount: 250,
        currency: 'USD',
      });

      const res = await request(app).get(`/transactions/${transferRes.body.transaction.id}`);

      expect(res.status).toBe(200);
      expect(res.body.transaction.id).toBe(transferRes.body.transaction.id);
      expect(res.body.entries).toHaveLength(2);
    });

    it('returns 404 for an unknown transaction', async () => {
      const res = await request(app).get(`/transactions/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });

    it('returns 400 ValidationError for a non-UUID transaction id', async () => {
      const res = await request(app).get('/transactions/not-a-uuid');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });
  });
});
