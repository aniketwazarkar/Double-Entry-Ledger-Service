import { Router } from 'express';
import * as transferService from '../../services/transferService';
import { asyncHandler } from '../errorHandler';
import { transferBodySchema } from '../validation';

export const transfersRouter = Router();

// Endpoint to initiate a transfer between two accounts
transfersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = transferBodySchema.parse(req.body);
    const result = await transferService.transfer(body);
    // Per the PRD Error Contract: a brand-new transfer is 201, a replay of an
    // existing idempotency key is 200 with the original transaction body.
    res.status(result.replayed ? 200 : 201).json(result);
  })
);
