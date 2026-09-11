import { Router } from 'express';
import * as transactionService from '../../services/transactionService';
import { asyncHandler } from '../errorHandler';
import { transactionIdParamsSchema } from '../validation';

export const transactionsRouter = Router();

transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = transactionIdParamsSchema.parse(req.params);
    const result = await transactionService.getTransactionWithEntries(id);
    res.status(200).json(result);
  })
);
