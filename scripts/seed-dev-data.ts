/* eslint-disable no-console */
// Not part of the plan/PRD — a one-off script for populating local Postgres
// with example data to inspect in pgAdmin. Not committed to the repo.
import * as accountService from '../src/services/accountService';
import * as transferService from '../src/services/transferService';
import db from '../src/db/knex';

async function main() {
  const alice = await accountService.createAccount({ name: 'Alice Wallet', currency: 'USD', type: 'liability' });
  const bob = await accountService.createAccount({ name: 'Bob Wallet', currency: 'USD', type: 'liability' });
  const promos = await accountService.createAccount({ name: 'Promotions Funding', currency: 'USD', type: 'equity' });
  const merchant = await accountService.createAccount({ name: 'Coffee Shop', currency: 'USD', type: 'liability' });

  await transferService.transfer({
    idempotencyKey: 'seed-topup-alice',
    fromAccountId: promos.id,
    toAccountId: alice.id,
    amount: 5000,
    currency: 'USD',
    description: 'wallet top-up',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-cashback-bob',
    fromAccountId: promos.id,
    toAccountId: bob.id,
    amount: 200,
    currency: 'USD',
    description: 'cashback:campaign-42',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-purchase-alice-coffee',
    fromAccountId: alice.id,
    toAccountId: merchant.id,
    amount: 450,
    currency: 'USD',
    description: 'coffee purchase',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-refund-coffee',
    fromAccountId: merchant.id,
    toAccountId: alice.id,
    amount: 450,
    currency: 'USD',
    description: 'refund_of:seed-purchase-alice-coffee',
  });

  await transferService.transfer({
    idempotencyKey: 'seed-alice-to-bob',
    fromAccountId: alice.id,
    toAccountId: bob.id,
    amount: 1000,
    currency: 'USD',
    description: 'splitting dinner',
  });

  console.log('Seeded accounts:');
  console.log({ alice: alice.id, bob: bob.id, promos: promos.id, merchant: merchant.id });

  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
