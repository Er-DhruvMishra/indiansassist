/**
 * Phase F foundation (docs/specs/phase-f-contracts.md sections 3.1a, 3.1c, 4.1b, 5.2c, 11, 15.1): the new
 * environment keys and their boot problems. Every address and key below is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const opts = { persistSecrets: false } as const;
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const K3 = 'c'.repeat(64);
const base = { NODE_ENV: 'test' };

describe('FLEET_DATA_KEYS_PREVIOUS (section 3.1c)', () => {
  it('is empty by default', () => {
    expect(loadConfig({ ...base, FLEET_DATA_KEY: K1 }, opts).fleet.previousKeys).toEqual([]);
  });

  it('parses "<keyId>:<64 hex>" entries when the current key names its id', () => {
    const c = loadConfig({ ...base, FLEET_DATA_KEY: `k2:${K2}`, FLEET_DATA_KEYS_PREVIOUS: ` k1:${K1} , k0:${K3} ` }, opts);
    expect(c.fleet.dataKeyId).toBe('k2');
    expect(c.fleet.previousKeys.map((k) => k.keyId)).toEqual(['k1', 'k0']);
    expect(c.fleet.previousKeys[0]!.key.equals(Buffer.from(K1, 'hex'))).toBe(true);
  });

  it('requires an explicit key id on the current key when previous keys are set', () => {
    expect(() => loadConfig({ ...base, FLEET_DATA_KEY: K2, FLEET_DATA_KEYS_PREVIOUS: `k1:${K1}` }, opts)).toThrow(
      /FLEET_DATA_KEY must carry an explicit "<keyId>:" prefix/,
    );
  });

  it('refuses a previous entry repeating the current id, a duplicate id, or a malformed entry', () => {
    expect(() => loadConfig({ ...base, FLEET_DATA_KEY: `k1:${K2}`, FLEET_DATA_KEYS_PREVIOUS: `k1:${K1}` }, opts)).toThrow(
      /repeats the current key id k1/,
    );
    expect(() =>
      loadConfig({ ...base, FLEET_DATA_KEY: `k3:${K3}`, FLEET_DATA_KEYS_PREVIOUS: `k1:${K1},k1:${K2}` }, opts),
    ).toThrow(/repeats the key id k1/);
    expect(() => loadConfig({ ...base, FLEET_DATA_KEY: `k3:${K3}`, FLEET_DATA_KEYS_PREVIOUS: K1 }, opts)).toThrow(
      /FLEET_DATA_KEYS_PREVIOUS entries must be/,
    );
  });
});

describe('SMTP_REQUIRE_TLS (section 4.1b)', () => {
  it('defaults to false outside production and parses an explicit value', () => {
    expect(loadConfig(base, opts).mail.requireTls).toBe(false);
    expect(loadConfig({ ...base, SMTP_REQUIRE_TLS: 'true' }, opts).mail.requireTls).toBe(true);
    expect(loadConfig({ ...base, SMTP_REQUIRE_TLS: '0' }, opts).mail.requireTls).toBe(false);
  });

  it('is a boot problem to turn it off in production for a non-loopback relay', () => {
    const prod = { NODE_ENV: 'production', MAIL_DRIVER: 'smtp', SMTP_REQUIRE_TLS: 'false' };
    expect(() => loadConfig({ ...prod, SMTP_URL: 'smtp://relay.example.test:587' }, opts)).toThrow(
      /SMTP_REQUIRE_TLS=false needs a loopback SMTP host with NODE_ENV=production/,
    );
    // Loopback is allowed (other production problems remain, but not this one).
    let msg = '';
    try {
      loadConfig({ ...prod, SMTP_URL: 'smtp://127.0.0.1:2525' }, opts);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).not.toMatch(/SMTP_REQUIRE_TLS/);
  });
});

describe('MAIL_FROM (section 3.1a)', () => {
  it('treats an empty value as the default, because compose passes ${MAIL_FROM:-}', () => {
    expect(loadConfig({ ...base, MAIL_FROM: '' }, opts).mail.from).toBe('IndiansAssist <no-reply@localhost>');
    expect(loadConfig({ ...base, MAIL_FROM: 'Support <support@example.test>' }, opts).mail.from).toBe('Support <support@example.test>');
  });
});

describe('ERASURE_DEV_COOLING_OFF_SEC (section 5.2c)', () => {
  it('is unset by default and a positive integer of seconds outside production', () => {
    expect(loadConfig(base, opts).erasure.devCoolingOffSec).toBeNull();
    expect(loadConfig({ ...base, ERASURE_DEV_COOLING_OFF_SEC: '5' }, opts).erasure.devCoolingOffSec).toBe(5);
    expect(() => loadConfig({ ...base, ERASURE_DEV_COOLING_OFF_SEC: '0' }, opts)).toThrow(/must be a positive integer/);
    expect(() => loadConfig({ ...base, ERASURE_DEV_COOLING_OFF_SEC: 'soon' }, opts)).toThrow(/must be a positive integer/);
  });

  it('is refused in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ERASURE_DEV_COOLING_OFF_SEC: '5' }, opts)).toThrow(
      /ERASURE_DEV_COOLING_OFF_SEC must not be set with NODE_ENV=production/,
    );
  });
});

describe('BACKUP_RETENTION_DAYS (section 11)', () => {
  it('is null when not stated and a positive integer otherwise', () => {
    expect(loadConfig(base, opts).backupRetentionDays).toBeNull();
    expect(loadConfig({ ...base, BACKUP_RETENTION_DAYS: '35' }, opts).backupRetentionDays).toBe(35);
    expect(() => loadConfig({ ...base, BACKUP_RETENTION_DAYS: '-1' }, opts)).toThrow(/BACKUP_RETENTION_DAYS must be a positive integer/);
  });
});
