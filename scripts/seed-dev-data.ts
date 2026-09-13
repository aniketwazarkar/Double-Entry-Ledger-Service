/* eslint-disable no-console */
// Not part of the plan/PRD — a one-off script for populating local Postgres
// with example data to inspect in pgAdmin. Not committed to the repo.
import * as accountService from '../src/services/accountService';
import * as transferService from '../src/services/transferService';
import db from '../src/db/knex';

async function main() {
  const aniket = await accountService.createAccount({ name: 'Aniket\'s Wallet', currency: 'USD', type: 'liability' });
  const virat = await accountService.createAccount({ name: 'Virat\'s Wallet', currency: 'USD', type: 'liability' });
  const promos = await accountService.createAccount({ name: 'Promotions Funding', currency: 'USD', type: 'equity' });
  const merchant = await accountService.createAccount({ name: 'Coffee Shop', currency: 'USD', type: 'liability' });
  const refunds = await accountService.createAccount({ name: 'Refunds', currency: 'USD', type: 'equity' });

  await transferService.transfer({
    idempotencyKey: 'seed-topup-aniket',
    fromAccountId: promos.id,
    toAccountId: aniket.id,
    amount: 5000,
    currency: 'USD',
    description: 'wallet top-up',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-cashback-virat',
    fromAccountId: promos.id,
    toAccountId: virat.id,
    amount: 200,
    currency: 'USD',
    description: 'cashback:campaign-42',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-purchase-aniket-coffee',
    fromAccountId: aniket.id,
    toAccountId: merchant.id,
    amount: 450,
    currency: 'USD',
    description: 'coffee purchase',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-refund-coffee',
    fromAccountId: merchant.id,
    toAccountId: aniket.id,
    amount: 450,
    currency: 'USD',
    description: 'refund_of:seed-purchase-aniket-coffee',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-aniket-to-virat',
    fromAccountId: aniket.id,
    toAccountId: virat.id,
    amount: 1000,
    currency: 'USD',
    description: 'splitting dinner',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-refund-virat',
    fromAccountId: refunds.id,
    toAccountId: virat.id,
    amount: 1000,
    currency: 'USD',
    description: 'refund_of:seed-aniket-to-virat',
  });

  console.log('Seeded accounts:');
  console.log({ aniket: aniket.id, virat: virat.id, promos: promos.id, merchant: merchant.id });

  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
