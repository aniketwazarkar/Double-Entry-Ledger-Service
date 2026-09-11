import * as accountService from '../../src/services/accountService';
import { NotFoundError } from '../../src/domain/errors';
import { closeDb, truncateAll } from './helpers/db';

describe('accountService', () => {
  afterEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('createAccount / getAccount', () => {
    it('round-trips all fields on create then fetch', async () => {
      const created = await accountService.createAccount({
        name: 'Checking',
        currency: 'USD',
        type: 'asset',
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.name).toBe('Checking');
      expect(created.currency).toBe('USD');
      expect(created.type).toBe('asset');
      expect(created.createdAt).toBeInstanceOf(Date);

      const fetched = await accountService.getAccount(created.id);

      expect(fetched).toEqual(created);
    });

    it('rejects fetching an unknown id with NotFoundError', async () => {
      await expect(
        accountService.getAccount('00000000-0000-0000-0000-000000000000')
      ).rejects.toThrow(NotFoundError);
    });
  });
});
