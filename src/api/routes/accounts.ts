import { Router } from 'express';
import * as accountService from '../../services/accountService';
import * as statementService from '../../services/statementService';
import { asyncHandler } from '../errorHandler';
import { accountIdParamsSchema, balanceQuerySchema, createAccountSchema, statementQuerySchema } from '../validation';

export const accountsRouter = Router();

accountsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createAccountSchema.parse(req.body);
    const account = await accountService.createAccount(body);
    res.status(201).json(account);
  })
);

// Only for FE testing purposes, not part of the public API
accountsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const accounts = await accountService.getAllAccounts();
    res.status(200).json(accounts);
  })
);

accountsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = accountIdParamsSchema.parse(req.params);
    const account = await accountService.getAccount(id);
    res.status(200).json(account);
  })
);

accountsRouter.get(
  '/:id/balance',
  asyncHandler(async (req, res) => {
    const { id } = accountIdParamsSchema.parse(req.params);
    const { asOf } = balanceQuerySchema.parse(req.query);
    const balance = await accountService.getBalance(id, asOf);
    res.status(200).json({ accountId: id, balance });
  })
);

accountsRouter.get(
  '/:id/statement',
  asyncHandler(async (req, res) => {
    const { id } = accountIdParamsSchema.parse(req.params);
    const { limit, cursor } = statementQuerySchema.parse(req.query);
    const page = await statementService.getStatement(id, { limit, cursor });
    res.status(200).json(page);
  })
);
