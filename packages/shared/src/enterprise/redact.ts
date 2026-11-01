/**
 * Phase E section 5.4: the one redaction implementation the console and the api share. The foundation lands the
 * names and shapes; the ai stream fills `REDACTION_RULES`, `redactText` and `verhoeffValid` (`luhnValid` is the Phase A one).
 */
import { z } from 'zod';
import { REDACTION_KINDS, type RedactionKind } from '../enums.js';
import { notBuilt } from './not-built.js';

/** An object keyed by every `REDACTION_KINDS` value, each a non-negative int (section 13.3). */
export type RedactionCounts = Record<RedactionKind, number>;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const redactionCountsSchema = z.strictObject(
  Object.fromEntries(REDACTION_KINDS.map((k) => [k, count])) as Record<RedactionKind, typeof count>,
);

/** All-zero counts. */
export function emptyRedactionCounts(): RedactionCounts {
  return Object.fromEntries(REDACTION_KINDS.map((k) => [k, 0])) as RedactionCounts;
}

/**
 * One state spans one whole input (section 5.4): the same value always maps to the same placeholder number, and
 * numbering of a kind continues above the highest `[<kind>-<n>]` already present.
 */
export type RedactionState = {
  counts: RedactionCounts;
  /** Per kind: matched value -> placeholder number. */
  seen: Record<RedactionKind, Map<string, number>>;
  /** Per kind: the highest placeholder number used so far. */
  next: Record<RedactionKind, number>;
};

/** One ordered rule of section 5.4 (filled by the ai stream). */
export type RedactionRule = { kind: RedactionKind; pattern: RegExp };

/** The section 5.4 rules in order (ai stream). */
export const REDACTION_RULES: readonly RedactionRule[] = [];

export function newRedactionState(): RedactionState {
  return {
    counts: emptyRedactionCounts(),
    seen: Object.fromEntries(REDACTION_KINDS.map((k) => [k, new Map<string, number>()])) as Record<RedactionKind, Map<string, number>>,
    next: emptyRedactionCounts(),
  };
}

/** Replaces every section 5.4 match with a typed placeholder (`[email-1]`), counting each kind in `state.counts`. */
export function redactText(_text: string, _state: RedactionState): string {
  return notBuilt('ai', 'redactText');
}

/**
 * Luhn check of a digit string (card numbers, section 5.4 rule 6). The Phase A short-code check already is a general
 * Luhn over any run of two or more digits, so the same function is re-exported rather than defined twice.
 */
export { luhnValid } from '../token/short-code.js';

/** Verhoeff check of a digit string (Aadhaar numbers, section 5.4 rule 7). */
export function verhoeffValid(_digits: string): boolean {
  return notBuilt('ai', 'verhoeffValid');
}
