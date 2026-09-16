import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { CurrencyMismatchError, NotFoundError, ValidationError } from '../domain/errors';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * pipeline (this codebase's Express 4 has no built-in async error handling).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Central error mapping, per docs/PRD.md's Error Contract table:
 *   ZodError / ValidationError        -> 400 ValidationError (+ details for ZodError)
 *   CurrencyMismatchError             -> 400 CurrencyMismatchError
 *   NotFoundError                     -> 404 NotFoundError
 *   anything else                     -> 500 InternalError, logged, never leaked
 *
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Request validation failed',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(400).json({
      error: 'ValidationError',
      message: err.message,
      details: [],
    });
    return;
  }

  if (err instanceof CurrencyMismatchError) {
    res.status(400).json({
      error: 'CurrencyMismatchError',
      message: err.message,
    });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({
      error: 'NotFoundError',
      message: err.message,
    });
    return;
  }

  // Unexpected error: log server-side only, never leak internals to the client.
  // eslint-disable-next-line no-console
  console.error('Unhandled error in request pipeline:', err);
  res.status(500).json({
    error: 'InternalError',
    message: 'An unexpected error occurred',
  });
};
