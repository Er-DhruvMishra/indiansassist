/**
 * Phase C section 8: playbooks. The catalogue row and its wire shape, parameters (`pattern` required for strings),
 * the session-start manifest, the run request and its `202` reply (the body release point), the argument
 * canonicalisation `validatePlaybookArgs` (server and agent), the body lint, and the `ia.playbook` output frames.
 * Mirrored by `ia_core::playbook` (Rust); vectors in `test/fixtures/agent/playbook-args.json` / `playbook-frames.json`.
 */
import { z } from 'zod';
import { LIMITS, PLAYBOOK_ERRORS, PLAYBOOK_INTERPRETERS, PLAYBOOK_RAN_AS, type PlaybookInterpreter } from '../enums.js';
import { sanitiseText } from '../audit/sanitise.js';
import { utf8Encode } from '../encoding.js';

const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`), `expected ${n} lower-case hex chars`);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected a uuid');
const iso = z.string();
const ts = z.number().int().nonnegative();
const bodyText = z
  .string()
  .min(1)
  .refine((b) => utf8Encode(b).length <= LIMITS.playbookBodyMaxBytes, `body is at most ${LIMITS.playbookBodyMaxBytes} UTF-8 bytes`);

export const PLAYBOOK_PARAM_TYPES = ['string', 'int', 'bool', 'enum'] as const;
export const PLAYBOOK_PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Section 8.4: every string value of a `cmd` playbook additionally matches this (the batch parser expands text). */
export const CMD_VALUE_RE = /^[A-Za-z0-9 ._:\\/-]{0,256}$/;
// eslint-disable-next-line no-control-regex
const C0_RE = /[\u0000-\u001f\u007f]/;
const STRING_VALUE_MAX = 4000;
const POWERSHELL_VALUE_MAX = 4096;

/** A `{n}` / `{n,}` / `{n,m}` quantifier at `s[i]` (i points at `{`): its maximum repeat, or null when `s[i]` is not one. */
function braceQuantMax(s: string, i: number): number | null {
  const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
  if (!m) return null;
  if (m[2] === undefined) return Number(m[1]); // {n}
  if (m[3] === undefined || m[3] === '') return Number.POSITIVE_INFINITY; // {n,}
  return Number(m[3]); // {n,m}
}

/** True when `s[i]` begins a quantifier that can repeat its atom two or more times (`*`, `+`, `{>=2}`). */
function repeatsTwiceOrMore(s: string, i: number): boolean {
  const c = s[i];
  if (c === '*' || c === '+') return true;
  if (c === '{') {
    const hi = braceQuantMax(s, i);
    return hi !== null && hi >= 2;
  }
  return false;
}

/** True when `s` holds an unbounded quantifier (`*`, `+`, `{n,}`) outside a character class or an escape. */
function hasUnboundedQuant(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      i++;
      while (i < s.length && s[i] !== ']') {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '*' || c === '+') return true;
    if (c === '{' && braceQuantMax(s, i) === Number.POSITIVE_INFINITY) return true;
  }
  return false;
}

/**
 * Heuristic for catastrophic backtracking (ReDoS): a repeated group whose body can itself repeat unboundedly, e.g.
 * `(a+)+`, `(a*)*`, `(?:\d+)+`. V8's backtracking engine stalls the shared event loop on such a pattern against a long
 * value, so the server rejects it at create / patch and at run time (the length cap bounds the rest). The check skips
 * escapes and character classes and only needs the catastrophic nesting, not a full parse.
 */
export function hasNestedQuantifier(p: string): boolean {
  const open: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      i++;
      while (i < p.length && p[i] !== ']') {
        if (p[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') open.push(i);
    else if (c === ')') {
      const start = open.pop();
      if (start === undefined) continue;
      if (repeatsTwiceOrMore(p, i + 1) && hasUnboundedQuant(p.slice(start + 1, i))) return true;
    }
  }
  return false;
}

/**
 * A pattern the server accepts: compiles, <= 200 chars, stays inside the RE2 subset (no lookaround, no backrefs) and
 * carries no nested-quantifier ReDoS (section 8.4). Compiling (bounded, <= 200 chars) is safe; matching an attacker's
 * value is the hazard, so callers gate the match on this check.
 */
export function isSafePattern(p: string): boolean {
  if (p.length === 0 || p.length > 200) return false;
  if (/\(\?[=!<]|\\[1-9]|\\k</.test(p)) return false;
  if (hasNestedQuantifier(p)) return false;
  try {
    new RegExp(`^(?:${p})$`, 'u');
    return true;
  } catch {
    return false;
  }
}

const paramBase = {
  name: z.string().regex(PLAYBOOK_PARAM_NAME_RE, 'lower-case name, letters, digits and _'),
  label: z.string().max(80),
  required: z.boolean(),
};

/** `PlaybookParam` (section 8.1), strict: `pattern` required for strings and absent otherwise. */
export const playbookParamSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...paramBase,
    type: z.literal('string'),
    pattern: z.string().refine(isSafePattern, 'pattern must be a valid RE2-style expression of at most 200 chars'),
    default: z.string().max(STRING_VALUE_MAX).optional(),
  }),
  z.strictObject({
    ...paramBase,
    type: z.literal('int'),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    default: z.number().int().optional(),
  }),
  z.strictObject({ ...paramBase, type: z.literal('bool'), default: z.boolean().optional() }),
  z.strictObject({
    ...paramBase,
    type: z.literal('enum'),
    enum: z.array(z.string().min(1).max(40)).min(1).max(20),
    default: z.string().max(40).optional(),
  }),
]);
export type PlaybookParam = z.infer<typeof playbookParamSchema>;

export const playbookParamsSchema = z
  .array(playbookParamSchema)
  .max(LIMITS.playbookParamsMax)
  .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, 'parameter names must be unique');

const name = z
  .string()
  .max(1000)
  .transform((s) => sanitiseText(s, 80).trim())
  .refine((s) => s.length >= 1 && s.length <= 80, 'name is 1..80 characters');
const description = z
  .string()
  .max(5000)
  .transform((s) => sanitiseText(s, 500));
const timeoutSec = z.number().int().min(1).max(LIMITS.playbookTimeoutMaxSec);

/**
 * Phase D rule 9.8: a vault reference of a playbook (org_admin only). The api reads `path` (relative to the org's
 * vault prefix) at dispatch and seals the value into the child's environment variable `env`. At most 8.
 */
export const PLAYBOOK_VAULT_ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const playbookVaultRefSchema = z.strictObject({
  env: z.string().regex(PLAYBOOK_VAULT_ENV_RE, 'an upper-case environment variable name'),
  path: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'a relative vault path')
    .refine((p) => !p.split('/').includes('..'), 'no .. segments'),
});
export type PlaybookVaultRef = z.infer<typeof playbookVaultRefSchema>;
export const playbookVaultRefsSchema = z
  .array(playbookVaultRefSchema)
  .max(8)
  .refine((r) => new Set(r.map((x) => x.env)).size === r.length, 'env names must be unique');

/** `Playbook` wire (section 8.2); `body` only for roles that may read bodies. */
export const playbookSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string(),
  interpreter: z.enum(PLAYBOOK_INTERPRETERS),
  requiresElevation: z.boolean(),
  parameters: z.array(playbookParamSchema),
  timeoutSec: z.number().int(),
  enabled: z.boolean(),
  bodyHash: hex(64),
  body: z.string().optional(),
  /** Phase D rule 9.8 (absent = none). */
  vaultRefs: playbookVaultRefsSchema.optional(),
  createdBy: z.object({ id: uuid, name: z.string() }).nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type Playbook = z.infer<typeof playbookSchema>;
export const playbooksPageSchema = z.object({ items: z.array(playbookSchema), nextCursor: z.string().nullable() });

export const playbookCreateSchema = z.strictObject({
  name,
  description: description.default(''),
  interpreter: z.enum(PLAYBOOK_INTERPRETERS),
  body: bodyText,
  requiresElevation: z.boolean().optional(),
  parameters: playbookParamsSchema.optional(),
  timeoutSec: timeoutSec.optional(),
  enabled: z.boolean().optional(),
  vaultRefs: playbookVaultRefsSchema.optional(),
});
export type PlaybookCreate = z.output<typeof playbookCreateSchema>;

export const playbookPatchSchema = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  interpreter: z.enum(PLAYBOOK_INTERPRETERS).optional(),
  body: bodyText.optional(),
  requiresElevation: z.boolean().optional(),
  parameters: playbookParamsSchema.optional(),
  timeoutSec: timeoutSec.optional(),
  enabled: z.boolean().optional(),
  vaultRefs: playbookVaultRefsSchema.nullable().optional(),
});
export type PlaybookPatch = z.output<typeof playbookPatchSchema>;

export const playbookListQuerySchema = z.object({
  enabled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageLimitMax).default(LIMITS.pageLimitDefault),
  cursor: z.string().min(1).max(512).optional(),
});

/** `session.created.agent.playbooks[]` (section 8.3): no body, the pinned hash only. */
export const playbookManifestSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string(),
  interpreter: z.enum(PLAYBOOK_INTERPRETERS),
  requiresElevation: z.boolean(),
  parameters: z.array(playbookParamSchema),
  timeoutSec: z.number().int(),
  bodyHash: hex(64),
  /** Phase D rule 9.8: the env names only (never a path); such a playbook runs only as a device action. */
  vaultRefs: z.array(z.strictObject({ env: z.string().regex(PLAYBOOK_VAULT_ENV_RE) })).max(8).optional(),
});
export type PlaybookManifest = z.infer<typeof playbookManifestSchema>;
export const sessionAgentSchema = z.strictObject({
  playbooks: z.array(playbookManifestSchema).max(LIMITS.playbookCatalogueMax),
  truncated: z.literal(true).optional(),
});
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

const argValue = z.union([z.string().max(STRING_VALUE_MAX * 4), z.number(), z.boolean()]);
/** `POST /sessions/:id/playbooks/:playbookId/run` body. */
export const playbookRunRequestSchema = z.strictObject({
  args: z.record(z.string().max(32), argValue).default({}),
  reason: z.string().max(LIMITS.reasonMax).optional(),
});

/** The `202` reply: copied verbatim into the encrypted `playbook.run` op with `ctl.req.id = runId`. */
export const playbookRunReplySchema = z.strictObject({
  runId: hex(32),
  opId: hex(16),
  playbookId: uuid,
  body: z.string(),
  bodyHash: hex(64),
  interpreter: z.enum(PLAYBOOK_INTERPRETERS),
  requiresElevation: z.boolean(),
  timeoutSec: z.number().int(),
  args: z.record(z.string(), z.string()),
});
export type PlaybookRunReply = z.infer<typeof playbookRunReplySchema>;

/** The `playbook.run` op args (section 8.4) built from a `202` reply. */
export function playbookRunOpArgs(r: PlaybookRunReply) {
  return {
    runId: r.runId,
    playbookId: r.playbookId,
    bodyHash: r.bodyHash,
    body: r.body,
    interpreter: r.interpreter,
    args: r.args,
    requiresElevation: r.requiresElevation,
    timeoutSec: r.timeoutSec,
  };
}

// ---------- argument canonicalisation (section 8.4) ----------

export type PlaybookArgValue = string | number | boolean;
export type PlaybookArgsResult = { ok: true; args: Record<string, string> } | { ok: false; error: string; param?: string };

const INT_CANON_RE = /^(?:0|-?[1-9]\d{0,15})$/;

function checkString(v: string, interpreter: PlaybookInterpreter): string | null {
  if (v.length > STRING_VALUE_MAX) return `longer than ${STRING_VALUE_MAX} characters`;
  if (C0_RE.test(v)) return 'contains control characters';
  if (interpreter === 'powershell' && v.length > POWERSHELL_VALUE_MAX) return 'too long for powershell';
  if (interpreter === 'cmd' && !CMD_VALUE_RE.test(v)) return 'contains characters a cmd playbook does not accept';
  return null;
}

/**
 * Canonicalises and validates playbook arguments. Typed input (the REST body) is the server path: no coercion from
 * strings to int / bool, strings NFC-normalised. With `canonical: true` every value is the canonical string the
 * server shipped (the agent path): `true` / `false`, decimal integers, strings already in NFC.
 */
export function validatePlaybookArgs(
  params: readonly PlaybookParam[],
  args: Readonly<Record<string, PlaybookArgValue>>,
  interpreter: PlaybookInterpreter,
  opts: { canonical?: boolean } = {},
): PlaybookArgsResult {
  const known = new Map(params.map((p) => [p.name, p]));
  for (const k of Object.keys(args)) if (!known.has(k)) return { ok: false, error: 'unknown parameter', param: k };
  const out: Record<string, string> = {};
  for (const p of params) {
    let v: PlaybookArgValue | undefined = Object.prototype.hasOwnProperty.call(args, p.name) ? args[p.name] : undefined;
    let fromDefault = false;
    if (v === undefined && p.default !== undefined) {
      v = p.default;
      fromDefault = true;
    }
    if (v === undefined) {
      if (p.required) return { ok: false, error: 'required', param: p.name };
      continue;
    }
    const canon = opts.canonical === true && !fromDefault;
    const bad = (error: string): PlaybookArgsResult => ({ ok: false, error, param: p.name });
    switch (p.type) {
      case 'bool': {
        if (canon) {
          if (v !== 'true' && v !== 'false') return bad('expected true or false');
          out[p.name] = v;
        } else {
          if (typeof v !== 'boolean') return bad('expected a boolean');
          out[p.name] = v ? 'true' : 'false';
        }
        break;
      }
      case 'int': {
        let n: number;
        if (canon) {
          if (typeof v !== 'string' || !INT_CANON_RE.test(v)) return bad('expected a canonical integer');
          n = Number(v);
        } else {
          if (typeof v !== 'number' || !Number.isSafeInteger(v)) return bad('expected an integer');
          n = v;
        }
        if (p.min !== undefined && n < p.min) return bad(`below ${p.min}`);
        if (p.max !== undefined && n > p.max) return bad(`above ${p.max}`);
        out[p.name] = String(n === 0 ? 0 : n);
        break;
      }
      case 'string':
      case 'enum': {
        if (typeof v !== 'string') return bad('expected a string');
        const s = canon ? v : v.normalize('NFC');
        if (canon && s.normalize('NFC') !== s) return bad('not in NFC');
        const err = checkString(s, interpreter);
        if (err) return bad(err);
        if (p.type === 'enum' && !p.enum.includes(s)) return bad('not one of the allowed values');
        if (p.type === 'string') {
          // Never run a rejected (e.g. nested-quantifier) pattern against the value: that is the ReDoS hazard.
          if (!isSafePattern(p.pattern)) return bad('pattern is not allowed');
          if (!new RegExp(`^(?:${p.pattern})$`, 'u').test(s)) return bad('does not match the pattern');
        }
        out[p.name] = s;
        break;
      }
    }
  }
  return { ok: true, args: out };
}

// ---------- body lint (section 8.1) ----------

const PS_WARN: [RegExp, string][] = [
  [/\bInvoke-Expression\b/i, 'Invoke-Expression runs text as code'],
  [/(^|[^\w-])iex\b/i, 'iex runs text as code'],
  [/\bAdd-Type\b/i, 'Add-Type compiles code'],
  [/\bStart-Process\b/i, 'Start-Process launches another program'],
  [/\bcmd(\.exe)?\s+\/c\b/i, 'cmd /c re-parses its arguments'],
  [/%IA_PARAM/i, 'use $env:IA_PARAM_* in PowerShell, not %IA_PARAM_%'],
];
const CMD_SAFE_SET_RE = /set\s+"[A-Za-z_][A-Za-z0-9_]*=%IA_PARAM_[A-Za-z0-9_]+%"/gi;

/** Warnings and refusals of the admin body editor; the api answers `400 validation_failed { lint }` on any error. */
export function lintPlaybookBody(interpreter: PlaybookInterpreter, body: string): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (interpreter === 'powershell') {
    for (const [re, msg] of PS_WARN) if (re.test(body)) warnings.push(msg);
  } else if (interpreter === 'cmd') {
    if (/%IA_PARAM_/i.test(body.replace(CMD_SAFE_SET_RE, '')))
      errors.push('a cmd body may reference %IA_PARAM_X% only inside set "x=%IA_PARAM_X%"');
  }
  return { warnings, errors };
}

// ---------- ia.playbook frames (section 8.5) ----------

export const pbOutputSchema = z.strictObject({
  t: z.literal('pb.output'),
  runId: hex(32),
  stream: z.enum(['stdout', 'stderr']),
  seq: z.number().int().nonnegative(),
  chunk: z.string().max(8192),
  ts,
});
export const pbEndSchema = z.strictObject({
  t: z.literal('pb.end'),
  runId: hex(32),
  exit: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean(),
  ranAs: z.enum(PLAYBOOK_RAN_AS),
  error: z.enum(PLAYBOOK_ERRORS).optional(),
  ts,
});
export type PbOutput = z.infer<typeof pbOutputSchema>;
export type PbEnd = z.infer<typeof pbEndSchema>;
export const pbMessageSchema = z.discriminatedUnion('t', [pbOutputSchema, pbEndSchema]);

/** `IA_FILE_OFFER <absolute path>` (section 8.5 O1): the agent opens the Desk's send prompt for that file. */
export const PLAYBOOK_FILE_OFFER_RE = /^IA_FILE_OFFER ([A-Za-z]:\\[^\r\n]+)$/;
export function parsePlaybookFileOffer(line: string): string | null {
  const m = PLAYBOOK_FILE_OFFER_RE.exec(line);
  return m ? m[1]! : null;
}
