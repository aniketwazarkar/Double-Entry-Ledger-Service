import { z } from 'zod';

const uuidSchema = z.string().uuid();

/** Integer minor-unit amount, strictly positive. Floats are rejected here. */
const amountSchema = z.number().int().positive();

const accountTypeSchema = z.enum(['asset', 'liability', 'equity']);

const currencySchema = z.string().trim().min(1);

export const createAccountSchema = z.object({
  name: z.string().trim().min(1),
  currency: currencySchema,
  type: accountTypeSchema,
});

export const accountIdParamsSchema = z.object({
  id: uuidSchema,
});

export const transactionIdParamsSchema = z.object({
  id: uuidSchema,
});

export const balanceQuerySchema = z.object({
  asOf: z.coerce.date().optional(),
});

export const statementQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
});

export const transferBodySchema = z.object({
  idempotencyKey: z.string().trim().min(1),
  fromAccountId: uuidSchema,
  toAccountId: uuidSchema,
  amount: amountSchema,
  currency: currencySchema,
  description: z.string().optional().nullable(),
});

export type CreateAccountBody = z.infer<typeof createAccountSchema>;
export type TransferBody = z.infer<typeof transferBodySchema>;
