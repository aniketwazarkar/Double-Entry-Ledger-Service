import db from '../db/knex';

export interface ReconciliationResult {
  balanced: boolean;
  totalDebits: number;
  totalCredits: number;
}

/**
 * Independently verifies the ledger's core invariant — total debits equal
 * total credits — by summing `entries` directly by direction. Deliberately
 * does not reuse any per-account balance logic (accountService, statementService,
 * etc.): the whole point is a cross-check computed from a separate code path.
 */
export async function reconcile(): Promise<ReconciliationResult> {
  const { rows } = await db.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS total_debits,
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS total_credits
     FROM entries`
  );

  const totalDebits = Number(rows[0].total_debits);
  const totalCredits = Number(rows[0].total_credits);

  return {
    balanced: totalDebits === totalCredits,
    totalDebits,
    totalCredits,
  };
}
