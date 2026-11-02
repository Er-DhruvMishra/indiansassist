/**
 * Phase E section 5.4: `redactText` against `fixtures/enterprise/redaction.json` (every kind, positives and
 * negatives, placeholder numbering, idempotence), the Verhoeff check and the placeholder reservation the api uses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REDACTION_KINDS,
  REDACTION_RULES,
  luhnValid,
  newRedactionState,
  redactText,
  reservePlaceholders,
  totalRedactions,
  verhoeffValid,
  type RedactionKind,
} from '../src/index.js';

type Positive = { text: string; secret: string; expected?: string };
type Vectors = {
  kinds: Record<RedactionKind, { positives: Positive[]; negatives: string[] }>;
  numbering: { texts: string[]; expected: string[] }[];
};
const V = JSON.parse(readFileSync(new URL('./fixtures/enterprise/redaction.json', import.meta.url), 'utf8')) as Vectors;

describe('redaction vectors (section 5.4)', () => {
  it('covers every kind with at least three positives and two negatives', () => {
    expect(Object.keys(V.kinds).sort()).toEqual([...REDACTION_KINDS].sort());
    for (const k of REDACTION_KINDS) {
      expect(V.kinds[k].positives.length, k).toBeGreaterThanOrEqual(3);
      expect(V.kinds[k].negatives.length, k).toBeGreaterThanOrEqual(2);
    }
    // The named edge cases of section 5.4.
    expect(V.kinds.card.negatives.some((t) => t.includes('Luhn-invalid'))).toBe(true);
    expect(V.kinds.aadhaar.negatives.some((t) => t.includes('Verhoeff-invalid'))).toBe(true);
    expect(V.kinds.phone.negatives.some((t) => t.includes('10.0.22631.4317'))).toBe(true);
  });

  for (const kind of REDACTION_KINDS) {
    describe(kind, () => {
      for (const p of V.kinds[kind].positives) {
        it(`redacts ${JSON.stringify(p.text.slice(0, 40))}`, () => {
          const state = newRedactionState();
          const out = redactText(p.text, state);
          expect(state.counts[kind]).toBeGreaterThanOrEqual(1);
          expect(out).not.toContain(p.secret);
          expect(out).toContain(`[${kind}-1]`);
          if (p.expected !== undefined) expect(out).toBe(p.expected);
        });
      }
      for (const n of V.kinds[kind].negatives) {
        it(`leaves ${JSON.stringify(n.slice(0, 40))} alone as ${kind}`, () => {
          const state = newRedactionState();
          redactText(n, state);
          expect(state.counts[kind]).toBe(0);
        });
      }
    });
  }

  it('a version string survives every rule', () => {
    const state = newRedactionState();
    expect(redactText('Windows 10.0.22631.4317 build', state)).toBe('Windows 10.0.22631.4317 build');
    expect(totalRedactions(state.counts)).toBe(0);
  });

  it('numbers placeholders per input and keeps one number per value', () => {
    for (const c of V.numbering) {
      const state = newRedactionState();
      expect(c.texts.map((t) => redactText(t, state))).toEqual(c.expected);
    }
  });

  it('is idempotent: redacted text does not change on a second pass, with a fresh or the same state', () => {
    for (const kind of REDACTION_KINDS)
      for (const p of V.kinds[kind].positives) {
        const once = redactText(p.text, newRedactionState());
        expect(redactText(once, newRedactionState())).toBe(once);
        const s = newRedactionState();
        const a = redactText(p.text, s);
        const before = totalRedactions(s.counts);
        expect(redactText(a, s)).toBe(a);
        expect(totalRedactions(s.counts)).toBe(before);
      }
  });

  it('counts every replacement and applies the rules in contract order', () => {
    const state = newRedactionState();
    const out = redactText('a@b.co a@b.co c@d.co 192.168.0.1', state);
    expect(out).toBe('[email-1] [email-1] [email-2] [ip-1]');
    expect(state.counts.email).toBe(3);
    expect(state.counts.ip).toBe(1);
    const order = [...new Set(REDACTION_RULES.map((r) => r.kind))];
    expect(order).toEqual([...REDACTION_KINDS]);
  });

  it('reservePlaceholders makes new numbers start above the browser placeholders (api re-redaction)', () => {
    const transcript = 'the user wrote to [email-2] and [phone-1]';
    const state = newRedactionState();
    reservePlaceholders(state, transcript);
    expect(redactText('reason: contact x@y.example', state)).toBe('reason: contact [email-3]');
    expect(redactText(transcript, state)).toBe(transcript);
  });

  it('Verhoeff and Luhn checks', () => {
    expect(verhoeffValid('2363')).toBe(true);
    expect(verhoeffValid('2364')).toBe(false);
    expect(verhoeffValid('234567890124')).toBe(true);
    expect(verhoeffValid('234567890125')).toBe(false);
    expect(verhoeffValid('')).toBe(false);
    expect(luhnValid('4111111111111111')).toBe(true);
  });
});
