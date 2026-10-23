/**
 * Keyset pagination helpers for the section 6.3 `Page<T>` cursors (`<createdAt ISO>|<id>` and `<seq>`).
 * `created_at` columns carry microseconds while the cursor carries milliseconds, so ordering and comparison both
 * use `date_trunc('milliseconds', created_at)`; otherwise rows inside the same millisecond would be skipped.
 */
import {
  decodeSeqCursor,
  decodeTimeIdCursor,
  encodeSeqCursor,
  encodeTimeIdCursor,
  LIMITS,
} from '@indiansassist/shared';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { DbError } from '../errors.js';

export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageQuery = { limit?: number; cursor?: string | null };

export class InvalidCursorError extends DbError {
  constructor() {
    super('invalid_cursor', 'cursor is not valid for this list');
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIMITS.pageLimitDefault;
  return Math.min(LIMITS.pageLimitMax, Math.max(1, Math.trunc(limit)));
}

export const msTrunc = (col: AnyColumn): SQL => sql`date_trunc('milliseconds', ${col})`;

/** WHERE fragment for the page after `cursor` in (created_at, id) order; null when no cursor. */
export function timeIdAfter(
  createdAt: AnyColumn,
  id: AnyColumn,
  cursor: string | null | undefined,
  dir: 'asc' | 'desc',
): SQL | null {
  if (!cursor) return null;
  const c = decodeTimeIdCursor(cursor);
  if (!c) throw new InvalidCursorError();
  const ts = new Date(c.createdAt).toISOString();
  return dir === 'desc'
    ? sql`(${msTrunc(createdAt)}, ${id}) < (${ts}::timestamptz, ${c.id}::uuid)`
    : sql`(${msTrunc(createdAt)}, ${id}) > (${ts}::timestamptz, ${c.id}::uuid)`;
}

export function timeIdOrder(createdAt: AnyColumn, id: AnyColumn, dir: 'asc' | 'desc'): SQL[] {
  return dir === 'desc'
    ? [sql`${msTrunc(createdAt)} desc`, sql`${id} desc`]
    : [sql`${msTrunc(createdAt)} asc`, sql`${id} asc`];
}

/** Builds a page from `limit + 1` fetched rows. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]!) };
}

export const timeIdCursorOf = (row: { createdAt: Date; id: string }): string =>
  encodeTimeIdCursor(row.createdAt.toISOString(), row.id);

export function seqBefore(seqCol: AnyColumn, cursor: string | null | undefined): SQL | null {
  if (!cursor) return null;
  const seq = decodeSeqCursor(cursor);
  if (seq === null) throw new InvalidCursorError();
  return sql`${seqCol} < ${seq}`;
}

export const seqCursorOf = (row: { seq: number }): string => encodeSeqCursor(row.seq);
