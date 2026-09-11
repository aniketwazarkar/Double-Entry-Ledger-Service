import { z } from 'zod';

/**
 * Every request-body field here is validated at the API boundary, before any
 * service function or DB call runs. This is deliberately stricter/different
 * from the service-layer checks (e.g. transferService.transfer's own
 * ValidationErrors on amount/ids) — the boundary check exists so a malformed
 * request produces a zod-shaped 400 with a `details` array, per the PRD Error
 * Contract, rather than reaching a service and failing on a differently
 * shaped error (or, for a non-UUID id, a raw Postgres error).
 */
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
