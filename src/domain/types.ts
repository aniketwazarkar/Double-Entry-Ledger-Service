export type AccountType = 'asset' | 'liability' | 'equity';

export type Direction = 'debit' | 'credit';

export interface Account {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  createdAt: Date;
}

export interface Transaction {
  id: string;
  idempotencyKey: string;
  description: string | null;
  createdAt: Date;
}

export interface Entry {
  id: string;
  transactionId: string;
  accountId: string;
  direction: Direction;
  amount: number;
  currency: string;
  createdAt: Date;
}
