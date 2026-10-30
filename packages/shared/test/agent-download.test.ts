/** Phase C section 2: manifest / prepare schemas, the filename grammar and the signed `.iaconfig` sidecar. */
import { describe, expect, it } from 'vitest';
import {
  AGENT_FILENAME_RE,
  agentDistFileName,
  agentFileName,
  downloadManifestSchema,
  downloadPrepareReplySchema,
  downloadPrepareSchema,
  iaconfigSchema,
  isValidShortCode,
  makeDeskCode,
  parseAgentFileName,
  publicKeyEntry,
  publicKeyFromSeed,
  signIaconfig,
  verifyIaconfig,
} from '../src/index.js';

const SEED = '11'.repeat(32);

describe('download schemas', () => {
  it('manifest builds are strict and arch follows the platform', () => {
    const b = { platform: 'windows', arch: 'x64', version: '0.3.0', size: 1, sha256: 'a'.repeat(64), signed: false, minOs: '10.0.17763' };
    expect(downloadManifestSchema.parse({ v: 1, builds: [b] }).builds).toHaveLength(1);
    expect(downloadManifestSchema.safeParse({ v: 1, builds: [{ ...b, file: 'x.exe' }] }).success).toBe(false);
    expect(downloadPrepareSchema.safeParse({ code: 'x', platform: 'windows', arch: 'universal' }).success).toBe(false);
    expect(downloadPrepareSchema.safeParse({ code: 'x', platform: 'android', arch: 'universal' }).success).toBe(true);
    expect(downloadPrepareSchema.safeParse({ code: 'x', platform: 'android', arch: 'x64' }).success).toBe(false);
    expect(
      downloadPrepareReplySchema.safeParse({ url: 'u', expiresAt: 'e', filename: 'f', deskCode: '123456789012', version: '0.3.0', sha256: 'b'.repeat(64), signed: true })
        .success,
    ).toBe(true);
    expect(agentDistFileName('windows', 'arm64', '0.3.0')).toBe('IndiansAssist-windows-arm64-0.3.0.exe');
    expect(agentDistFileName('android', 'universal', '0.3.0')).toBe('IndiansAssist-android-universal-0.3.0.apk');
  });
});

describe('filename grammar (section 2.3)', () => {
  it('round-trips a minted desk code with the region', () => {
    const code = makeDeskCode();
    expect(isValidShortCode(code)).toBe(true);
    const name = agentFileName('in-mum', code);
    expect(name).toMatch(/^IndiansAssist-in-mum-\d{4}-\d{4}-\d{4}\.exe$/);
    expect(parseAgentFileName(name)).toEqual({ region: 'in-mum', deskCode: code });
  });
  it('tolerates the browser duplicate suffix and case, refuses a bad region or Luhn', () => {
    const code = makeDeskCode();
    const dup = agentFileName('eu-fra', code).replace('.exe', ' (1).exe');
    expect(parseAgentFileName(dup)?.deskCode).toBe(code);
    expect(parseAgentFileName(agentFileName('us-east', code).toUpperCase().replace('.EXE', '.exe'))?.region).toBe('us-east');
    expect(parseAgentFileName(agentFileName('in-mum', code).replace('in-mum', 'xx-yyy'))).toBeNull();
    const bad = code.slice(0, 11) + String((Number(code[11]) + 1) % 10);
    expect(parseAgentFileName(agentFileName('in-mum', bad))).toBeNull();
    expect(AGENT_FILENAME_RE.test('IndiansAssist.exe')).toBe(false);
  });
  it('a desk code never equals the avoided short code', () => {
    let n = 0;
    const seq = () => {
      n += 1;
      return new Uint8Array(32).fill(n < 3 ? 7 : n);
    };
    const first = makeDeskCode(null, () => new Uint8Array(32).fill(7));
    expect(makeDeskCode(first, seq)).not.toBe(first);
  });
});

describe('signed .iaconfig (section 2.4)', () => {
  it('signs, verifies, and refuses tampering, unknown kids and unknown keys', async () => {
    const pub = await publicKeyFromSeed(SEED);
    const key = publicKeyEntry(pub);
    const text = await signIaconfig({ v: 1, apiOrigin: 'https://in.example.test', region: 'in-mum', code: '123456789012', kid: key.kid }, SEED);
    const cfg = await verifyIaconfig(text, [key]);
    expect(cfg?.region).toBe('in-mum');
    expect(iaconfigSchema.safeParse(JSON.parse(text)).success).toBe(true);
    const tampered = text.replace('in.example.test', 'evil.example.test');
    expect(await verifyIaconfig(tampered, [key])).toBeNull();
    expect(await verifyIaconfig(text, [])).toBeNull();
    const extra = JSON.stringify({ ...JSON.parse(text), pubkeys: [] });
    expect(await verifyIaconfig(extra, [key])).toBeNull();
    expect(iaconfigSchema.safeParse({ ...JSON.parse(text), apiOrigin: 'https://x.test/path' }).success).toBe(false);
  });
});
