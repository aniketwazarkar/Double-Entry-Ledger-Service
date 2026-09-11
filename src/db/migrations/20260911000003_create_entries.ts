import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('entries', (table) => {
    table.uuid('id').primary().notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('transaction_id').notNullable().references('id').inTable('transactions');
    table.uuid('account_id').notNullable().references('id').inTable('accounts');
    table.text('direction').notNullable();
    table.bigInteger('amount').notNullable();
    table.text('currency').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.check("direction in ('debit', 'credit')", undefined, 'entries_direction_check');
    table.check('amount > 0', undefined, 'entries_amount_positive_check');

    // Statement/balance reads walk an account's entries in stable chronological order.
    table.index(['account_id', 'created_at', 'id'], 'entries_account_id_created_at_id_index');
    table.index(['transaction_id'], 'entries_transaction_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('entries');
}
