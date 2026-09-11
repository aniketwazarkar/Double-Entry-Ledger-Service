import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transactions', (table) => {
    table.uuid('id').primary().notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('idempotency_key').notNullable().unique('transactions_idempotency_key_unique');
    table.text('description').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('transactions');
}
