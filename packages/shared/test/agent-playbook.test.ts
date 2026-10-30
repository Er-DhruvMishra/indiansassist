/** Phase C section 8: playbook schemas, argument canonicalisation vectors, the cmd rule, the lint and the frames. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CMD_VALUE_RE,
  AGENT_CONTROL_ARGS,
  lintPlaybookBody,
  parseDataChannelMessage,
  parsePlaybookFileOffer,
  pbEndSchema,
  pbOutputSchema,
  playbookCreateSchema,
  playbookParamSchema,
  playbookRunOpArgs,
  playbookRunReplySchema,
  sha256Hex,
  validatePlaybookArgs,
  type PlaybookParam,
} from '../src/index.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/agent/${n}`, import.meta.url), 'utf8'));
const args = fx('playbook-args.json') as {
  params: PlaybookParam[];
  cases: { name: string; interpreter: 'powershell' | 'cmd'; args: Record<string, string | number | boolean>; ok: boolean; canonical?: Record<string, string>; param?: string }[];
  cmdCases: { name: string; value: string; ok: boolean }[];
  canonicalCases: { name: string; args: Record<string, string>; ok: boolean; param?: string }[];
};
const frames = fx('playbook-frames.json');

describe('playbook params', () => {
  it('the fixture params parse; pattern is required for strings and absent for other types', () => {
    for (const p of args.params) expect(playbookParamSchema.safeParse(p).success).toBe(true);
    expect(playbookParamSchema.safeParse({ name: 'x', label: 'X', type: 'string', required: true }).success).toBe(false);
    expect(playbookParamSchema.safeParse({ name: 'x', label: 'X', type: 'int', required: true, pattern: '.*' }).success).toBe(false);
    expect(playbookParamSchema.safeParse({ name: 'X', label: 'X', type: 'bool', required: true }).success).toBe(false);
    expect(playbookParamSchema.safeParse({ name: 'x', label: 'X', type: 'string', required: true, pattern: '(?=a)a' }).success).toBe(false);
  });

  it('create body: unique param names, body size, timeout range', () => {
    const base = { name: 'Flush DNS', interpreter: 'cmd', body: 'ipconfig /flushdns' };
    expect(playbookCreateSchema.parse(base).description).toBe('');
    expect(playbookCreateSchema.safeParse({ ...base, timeoutSec: 901 }).success).toBe(false);
    expect(playbookCreateSchema.safeParse({ ...base, body: 'x'.repeat(65537) }).success).toBe(false);
    const p = { name: 'a', label: 'A', type: 'bool', required: false };
    expect(playbookCreateSchema.safeParse({ ...base, parameters: [p, p] }).success).toBe(false);
    expect(playbookCreateSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('validatePlaybookArgs vectors (playbook-args.json)', () => {
  for (const c of args.cases) {
    it(c.name, () => {
      const r = validatePlaybookArgs(args.params, c.args, c.interpreter);
      expect(r.ok).toBe(c.ok);
      if (r.ok) expect(r.args).toEqual(c.canonical);
      else expect(r.param).toBe(c.param);
    });
  }
  for (const c of args.canonicalCases) {
    it(c.name, () => {
      const r = validatePlaybookArgs(args.params, c.args, 'powershell', { canonical: true });
      expect(r.ok).toBe(c.ok);
      if (!r.ok) expect(r.param).toBe(c.param);
    });
  }
  it('the server canonicalisation is idempotent on the agent path', () => {
    const r = validatePlaybookArgs(args.params, { host: 'example.com', count: 7, verbose: true }, 'powershell');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = validatePlaybookArgs(args.params, r.args, 'powershell', { canonical: true });
    expect(again).toEqual(r);
  });
  it('NFC normalisation happens on the server', () => {
    const p: PlaybookParam[] = [{ name: 's', label: 'S', type: 'string', required: true, pattern: '.{1,10}' }];
    const r = validatePlaybookArgs(p, { s: 'é' }, 'powershell');
    expect(r).toEqual({ ok: true, args: { s: 'é' } });
    expect(validatePlaybookArgs(p, { s: 'é' }, 'powershell', { canonical: true }).ok).toBe(false);
  });
  it('cmd value rule', () => {
    for (const c of args.cmdCases) expect(CMD_VALUE_RE.test(c.value)).toBe(c.ok);
    const p: PlaybookParam[] = [{ name: 'path', label: 'Path', type: 'string', required: true, pattern: '.{1,300}' }];
    expect(validatePlaybookArgs(p, { path: 'x & calc' }, 'cmd').ok).toBe(false);
    expect(validatePlaybookArgs(p, { path: 'x & calc' }, 'powershell').ok).toBe(true);
  });
});

describe('lintPlaybookBody', () => {
  it('warns on risky PowerShell', () => {
    const r = lintPlaybookBody('powershell', 'iex $x; Invoke-Expression $y; Add-Type x; Start-Process y; cmd /c dir; %IA_PARAM_X%');
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(6);
    expect(lintPlaybookBody('powershell', 'Get-ChildItem $env:TEMP').warnings).toEqual([]);
  });
  it('refuses a cmd body with %IA_PARAM_ outside the quoted set form', () => {
    expect(lintPlaybookBody('cmd', 'set "host=%IA_PARAM_HOST%"\r\nping "%host%"').errors).toEqual([]);
    expect(lintPlaybookBody('cmd', 'ping %IA_PARAM_HOST%').errors).toHaveLength(1);
    expect(lintPlaybookBody('cmd', 'set host=%IA_PARAM_HOST%').errors).toHaveLength(1);
  });
});

describe('ia.playbook frames (playbook-frames.json)', () => {
  it('pb.output / pb.end parse and belong on ia.playbook only', () => {
    expect(pbOutputSchema.parse(frames.output)).toEqual(frames.output);
    expect(pbEndSchema.parse(frames.end)).toEqual(frames.end);
    expect(pbEndSchema.parse(frames.endError)).toEqual(frames.endError);
    expect(parseDataChannelMessage('ia.playbook', JSON.stringify(frames.output)).ok).toBe(true);
    const wrong = parseDataChannelMessage('ia.control', JSON.stringify(frames.end));
    expect(wrong.ok).toBe(false);
    expect(pbOutputSchema.safeParse({ ...frames.output, chunk: 'x'.repeat(8193) }).success).toBe(false);
  });
  it('the 202 reply builds the playbook.run op verbatim (and its hash is the body hash)', () => {
    const reply = playbookRunReplySchema.parse(frames.runReply);
    expect(sha256Hex(reply.body)).toBe(reply.bodyHash);
    const op = playbookRunOpArgs(reply);
    expect(AGENT_CONTROL_ARGS['playbook.run'].parse(op)).toEqual(op);
    const ctl = parseDataChannelMessage('ia.control', JSON.stringify({ t: 'ctl.req', id: reply.runId, op: 'playbook.run', args: op, ts: 1 }));
    expect(ctl.ok).toBe(true);
  });
  it('IA_FILE_OFFER marker', () => {
    expect(parsePlaybookFileOffer(frames.fileOffer.line)).toBe(frames.fileOffer.path);
    expect(parsePlaybookFileOffer('IA_FILE_OFFER relative\\path.zip')).toBeNull();
    expect(parsePlaybookFileOffer('IA_FILE_OFFER')).toBeNull();
  });
});
