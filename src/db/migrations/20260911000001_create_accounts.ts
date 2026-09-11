import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.schema.createTable('accounts', (table) => {
    table.uuid('id').primary().notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('currency').notNullable();
    table.text('type').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.check("type in ('asset', 'liability', 'equity')", undefined, 'accounts_type_check');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('accounts');
}
