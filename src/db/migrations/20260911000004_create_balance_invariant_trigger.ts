import type { Knex } from 'knex';

/**
 * The balance invariant: for every transaction, SUM(debits) - SUM(credits) = 0.
 *
 * This is enforced by the database itself, not by application code, so it holds
 * under any concurrency and for any writer (including psql).
 *
 * Why a DEFERRABLE INITIALLY DEFERRED constraint trigger:
 * a transfer inserts its debit and its credit as sibling rows. At the moment the
 * first row hits the table the transaction is legitimately unbalanced, so the
 * check cannot run at statement time — it must run at COMMIT, once every row of
 * the transaction is in place. Deferral is what makes that possible.
 *
 * Why FOR EACH ROW: PostgreSQL's CREATE CONSTRAINT TRIGGER grammar supports only
 * FOR EACH ROW, and accepts no REFERENCING ... NEW TABLE clause (verified against
 * postgres:16 — both spellings are syntax errors). The usual objection to a
 * row-level trigger is that it cannot see the sibling rows of its own multi-row
 * INSERT; that objection does not apply here, because deferral moves execution to
 * COMMIT time and the function re-queries `entries` rather than reading NEW. By
 * then every sibling row is visible, so each firing evaluates the same, complete,
 * final state of the transaction.
 *
 * The trigger covers UPDATE and DELETE as well as INSERT, so the invariant cannot
 * be broken after the fact by editing or removing a single leg.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      affected_transaction_ids uuid[] := ARRAY[]::uuid[];
      target_id uuid;
      net bigint;
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        affected_transaction_ids := affected_transaction_ids || NEW.transaction_id;
      END IF;
      IF TG_OP <> 'INSERT' THEN
        affected_transaction_ids := affected_transaction_ids || OLD.transaction_id;
      END IF;

      FOREACH target_id IN ARRAY affected_transaction_ids LOOP
        -- Re-query the table (not NEW) so that, at COMMIT time, every entry of
        -- this transaction is counted regardless of which statement inserted it.
        -- A transaction with no entries left sums to 0 and is therefore balanced.
        SELECT COALESCE(
                 SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END),
                 0
               )
          INTO net
          FROM entries
         WHERE transaction_id = target_id;

        IF net <> 0 THEN
          RAISE EXCEPTION
            'unbalanced transaction %: sum(debits) - sum(credits) = %', target_id, net
            USING ERRCODE = '23514';
        END IF;
      END LOOP;

      RETURN NULL;
    END;
    $$;
  `);

  await knex.raw(`
    CREATE CONSTRAINT TRIGGER entries_balance_invariant
      AFTER INSERT OR UPDATE OR DELETE ON entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS entries_balance_invariant ON entries');
  await knex.raw('DROP FUNCTION IF EXISTS assert_transaction_balanced()');
}
