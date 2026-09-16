import path from 'path';
import express, { Express } from 'express';
import { accountsRouter } from './routes/accounts';
import { transfersRouter } from './routes/transfers';
import { transactionsRouter } from './routes/transactions';
import { internalRouter } from './routes/internal';
import { errorHandler } from './errorHandler';

export const app: Express = express();

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/accounts', accountsRouter);
app.use('/transfers', transfersRouter);
app.use('/transactions', transactionsRouter);
app.use('/internal', internalRouter);
app.use(errorHandler);
