import request from 'supertest';
import * as accountService from '../../src/services/accountService';
import * as transferService from '../../src/services/transferService';
import * as reconciliationService from '../../src/services/reconciliationService';
import { app } from '../../src/api/app';
import { closeDb, truncateAll } from './helpers/db';
import { Account } from '../../src/domain/types';

async function makeAccount(name: string, currency = 'USD'): Promise<Account> {
  return accountService.createAccount({ name, currency, type: 'asset' });
}

describe('reconciliation', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('reconciliationService.reconcile', () => {
    it('reports balanced with zero totals on an empty ledger', async () => {
      const result = await reconciliationService.reconcile();

      expect(result).toEqual({ balanced: true, totalDebits: 0, totalCredits: 0 });
    });

    it('reports balanced with correct totals after several transfers', async () => {
      const from = await makeAccount('From');
      const to = await makeAccount('To');
      const other = await makeAccount('Other');

      await transferService.transfer({
        idempotencyKey: 'r-1',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 1000,
        currency: 'USD',
      });
      await transferService.transfer({
        idempotencyKey: 'r-2',
        fromAccountId: to.id,
        toAccountId: other.id,
        amount: 400,
        currency: 'USD',
      });
      await transferService.transfer({
        idempotencyKey: 'r-3',
        fromAccountId: other.id,
        toAccountId: from.id,
        amount: 250,
        currency: 'USD',
      });

      const result = await reconciliationService.reconcile();

      expect(result.balanced).toBe(true);
      expect(result.totalDebits).toBe(1650);
      expect(result.totalCredits).toBe(1650);
    });
  });

  describe('GET /internal/reconcile', () => {
    it('returns balanced with zero totals for an empty ledger', async () => {
      const res = await request(app).get('/internal/reconcile');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ balanced: true, totalDebits: 0, totalCredits: 0 });
    });

    it('returns balanced with correct totals after a transfer', async () => {
      const from = await makeAccount('From');
      const to = await makeAccount('To');

      await transferService.transfer({
        idempotencyKey: 'r-http-1',
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 750,
        currency: 'USD',
      });

      const res = await request(app).get('/internal/reconcile');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ balanced: true, totalDebits: 750, totalCredits: 750 });
    });
  });
});
