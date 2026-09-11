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
 *
 * CAUTION for application code: never issue `SET CONSTRAINTS ALL IMMEDIATE` in a
 * session that performs multi-leg inserts. That undeferrs this trigger, forcing it
 * to fire per row during the statement, at which point a perfectly legitimate
 * balanced transfer is rejected on its first leg because the counterpart row does
 * not exist yet. This fails closed (it cannot admit bad data, only refuse good
 * data), but it is baffling to debug if you do not know to look for it.
 */
export async function up(knex: Knex): Promise<void> {
  // Two guards against temp-table shadowing, both deliberate:
  //
  // 1. `SET search_path = pg_catalog, public, pg_temp`. Without a search_path guard,
  //    a session that runs `CREATE TEMP TABLE entries (...)` makes the query below
  //    sum its own empty temp table instead of the real one, and an unbalanced
  //    transaction commits silently. Creating temp tables needs only the TEMP
  //    privilege, granted to PUBLIC by default, so this is reachable by any writer
  //    and can even happen by accident.
  //
  //    Note `pg_temp` is listed EXPLICITLY, and listed LAST. This is the part that
  //    is easy to get wrong: PostgreSQL searches the temp schema first for relation
  //    names even when it does not appear in search_path at all. Simply writing
  //    `SET search_path = pg_catalog, public` does NOT close the hole — verified by
  //    test. Naming pg_temp explicitly is the only way to pin where it is searched.
  //
  // 2. The query schema-qualifies `public.entries` anyway, so resolution does not
  //    depend on search_path being right. Belt and braces on the single query the
  //    entire ledger invariant rests on.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
    AS $$
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
          FROM public.entries
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
