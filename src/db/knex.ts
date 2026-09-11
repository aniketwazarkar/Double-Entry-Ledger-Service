import knexFactory, { Knex } from 'knex';
import config from '../../knexfile';

const db: Knex = knexFactory(config);

export default db;
