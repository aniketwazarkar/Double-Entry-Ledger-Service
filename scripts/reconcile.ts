import db from '../src/db/knex';
import { reconcile } from '../src/services/reconciliationService';

async function main(): Promise<number> {
  const result = await reconcile();
  console.log(JSON.stringify(result, null, 2));
  return result.balanced ? 0 : 1;
}

main()
  .then((exitCode) => {
    db.destroy().finally(() => process.exit(exitCode));
  })
  .catch((err) => {
    console.error('Reconciliation failed:', err);
    db.destroy().finally(() => process.exit(1));
  });
