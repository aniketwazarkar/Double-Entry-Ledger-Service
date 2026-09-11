export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class CurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyMismatchError';
    Object.setPrototypeOf(this, CurrencyMismatchError.prototype);
  }
}
