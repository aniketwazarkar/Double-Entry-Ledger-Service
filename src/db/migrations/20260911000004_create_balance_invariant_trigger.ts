import type { Knex } from 'knex';

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
