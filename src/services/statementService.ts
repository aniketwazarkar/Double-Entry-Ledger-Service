import db from '../db/knex';
import { Direction, Entry } from '../domain/types';
import { ValidationError } from '../domain/errors';
import { getAccount } from './accountService';

export interface StatementRow {
  entry: Entry;
  /** The account's balance as of (and including) this entry. */
  runningBalance: number;
}

export interface StatementPage {
  rows: StatementRow[];
  /** Opaque cursor for the next page, or null when this was the last page. */
  nextCursor: string | null;
}

export interface GetStatementOptions {
  limit?: number;
  cursor?: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * The cursor's timestamp is carried as the *text* PostgreSQL printed for
 * `created_at`, never as a JS `Date`.
 *
 * This is the crux of the whole design. `created_at` is a timestamptz with
 * microsecond resolution; a JS `Date` has only milliseconds. If the cursor were
 * built from `row.created_at` (which node-postgres has already truncated to a
 * Date), then for an entry stored at `…:00.000_400` the cursor would say
 * `…:00.000_000`, and a keyset predicate of `(created_at, id) > (cursor_ts,
 * cursor_id)` would compare against a timestamp *earlier* than the row it was
 * supposed to resume after. Every other entry in that same millisecond with a
 * larger id — including the cursor row itself — would then compare greater and
 * be returned a second time, so a page boundary landing inside a busy
 * millisecond would replay rows forever instead of advancing. Widening the
 * comparison the way `getBalance`'s `asOf` does is not an option here either:
 * that would skip the tail of the millisecond instead.
 *
 * Round-tripping the microsecond-precision text through `?::timestamptz` is
 * exact, so the keyset comparison is done on the true stored value and the
 * boundary is neither lossy nor ambiguous. `created_at` alone is not enough to
 * identify a position (many entries can share one microsecond — a transfer's
 * two legs always do), so the id is part of the cursor and part of the
 * comparison.
 */
interface CursorPosition {
  /** Postgres' own text rendering, e.g. `2026-01-01 00:00:00.000400+00`. */
  createdAt: string;
  id: string;
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('cursor is not a valid statement cursor');
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    parsed[0] === '' ||
    parsed[1] === ''
  ) {
    throw new ValidationError('cursor is not a valid statement cursor');
  }

  return { createdAt: parsed[0], id: parsed[1] };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

interface StatementQueryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: Direction;
  /** `bigint` — node-postgres hands these back as strings. */
  amount: string;
  currency: string;
  created_at: Date;
  /** Postgres' text rendering of `created_at`, at full microsecond precision. */
  created_at_text: string;
  /** `bigint` — a string, like every other bigint out of pg. */
  running_balance: string;
}

/**
 * A page of an account's history, oldest first, each row carrying the account's
 * balance as of (and including) that row.
 *
 * Keyset (not offset) pagination on `(created_at, id)`: a cursor names a row,
 * not a position in a count, so entries appended while a client is paging can
 * neither shift a page's contents nor cause a row to be skipped or repeated.
 *
 * Everything is computed in one statement, and therefore against one snapshot.
 * That matters for the running balance, which is the sum of two pieces: the
 * balance accumulated strictly at-or-before the cursor row (`base`) and the
 * cumulative sum within the page. Computed as two round trips, a write
 * committing in between could be counted in one piece and not the other,
 * producing a running balance that never existed. As one statement, the two
 * pieces always agree.
 *
 * `base` deliberately re-sums the account's history from the beginning on every
 * page, rather than trusting a balance carried in the cursor. A client-supplied
 * running total would be a number the service cannot verify, and it is exactly
 * what `runningBalance` is supposed to be an authoritative statement about.
 */
export async function getStatement(
  accountId: string,
  options: GetStatementOptions = {},
): Promise<StatementPage> {
  const limit = normalizeLimit(options.limit);
  const position = options.cursor === undefined ? null : decodeCursor(options.cursor);

  // Throws NotFoundError for an unknown account, so an empty statement always
  // means "this account has no entries" and never "no such account".
  await getAccount(accountId);

  // LIMIT n+1: the extra row is only ever used to decide `hasMore`, so an
  // exactly-full final page reports nextCursor: null instead of handing back a
  // cursor that would resolve to an empty page.
  const { rows } = await db.raw<{ rows: StatementQueryRow[] }>(
    `
    WITH base AS (
      SELECT COALESCE(
               SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END),
               0
             ) AS balance
        FROM entries
       WHERE account_id = :accountId
         AND :hasCursor::boolean
         AND (created_at, id) <= (:cursorCreatedAt::timestamptz, :cursorId::uuid)
    ),
    page AS (
      SELECT id, transaction_id, account_id, direction, amount, currency, created_at
        FROM entries
       WHERE account_id = :accountId
         AND (
           NOT :hasCursor::boolean
           OR (created_at, id) > (:cursorCreatedAt::timestamptz, :cursorId::uuid)
         )
       ORDER BY created_at, id
       LIMIT :fetchLimit
    )
    SELECT page.*,
           page.created_at::text AS created_at_text,
           (SELECT balance FROM base)
             + SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)
               OVER (ORDER BY created_at, id) AS running_balance
      FROM page
     ORDER BY created_at, id
  `,
    {
      accountId,
      hasCursor: position !== null,
      // Bound as NULL when there is no cursor; the `hasCursor` guards above mean
      // neither comparison is ever evaluated in that case.
      cursorCreatedAt: position?.createdAt ?? null,
      cursorId: position?.id ?? null,
      fetchLimit: limit + 1,
    },
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const statementRows: StatementRow[] = pageRows.map((row) => ({
    entry: {
      id: row.id,
      transactionId: row.transaction_id,
      accountId: row.account_id,
      direction: row.direction,
      // bigint arrives as a string from pg; Entry.amount is a TS number.
      amount: Number(row.amount),
      currency: row.currency,
      createdAt: row.created_at,
    },
    runningBalance: Number(row.running_balance),
  }));

  const last = pageRows[pageRows.length - 1];

  return {
    rows: statementRows,
    // Built from `created_at_text`, not from the Date on the returned entry —
    // see the CursorPosition note above.
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.created_at_text, id: last.id }) : null,
  };
}
