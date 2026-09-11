import { Router } from 'express';
import * as reconciliationService from '../../services/reconciliationService';
import { asyncHandler } from '../errorHandler';

export const internalRouter = Router();

internalRouter.get(
  '/reconcile',
  asyncHandler(async (_req, res) => {
    const result = await reconciliationService.reconcile();
    res.status(200).json(result);
  })
);
