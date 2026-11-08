import { describe, expect, it } from 'vitest';
import { bootMigration, loadConfig } from '../src/config.js';

const opts = { persistSecrets: false };
const hex = 'a'.repeat(64);
const APP_URL = 'postgres://ia_app:p@postgres:5432/indiansassist';
const OWNER_URL = 'postgres://ia_owner:p@postgres:5432/indiansassist';

// What infra/docker-compose.yml gives the api: the restricted role, and deliberately no owner credential.
const composeApi = {
  NODE_ENV: 'production',
  DATABASE_URL: APP_URL,
  MIGRATE_DATABASE_URL: '',
  DB_APP_ROLE: 'ia_app',
  SESSION_COOKIE_SECRET: hex,
  TOKEN_SIGNING_KEY: hex,
  WEB_ORIGIN: 'https://api.indiansassist.test',
  API_ORIGIN: 'https://api.indiansassist.test',
  SERVED_REGIONS: 'in-mum',
  DEFAULT_REGION: 'in-mum',
  FLEET_DATA_KEY: `k1:${hex}`,
  ORG_SECRETS_KEY: `k1:${hex}`,
  ORG_SECRETS_FP_KEY: hex,
};

describe('the migrations the api runs at boot', () => {
  it('none in the production Compose stack: the restricted role cannot migrate and the migrate service already did', () => {
    const config = loadConfig(composeApi, opts);
    expect(config.migrateDatabaseUrl).toBe('');
    expect(bootMigration(config)).toBe('none');
  });

  it('on the owner connection when production is given one', () => {
    const config = loadConfig({ ...composeApi, MIGRATE_DATABASE_URL: OWNER_URL }, opts);
    expect(config.migrateDatabaseUrl).toBe(OWNER_URL);
    expect(bootMigration(config)).toBe('owner');
  });

  it('on the app connection in development, where the owner URL defaults to DATABASE_URL', () => {
    const config = loadConfig({ DATABASE_URL: APP_URL }, opts);
    expect(config.migrateDatabaseUrl).toBe(APP_URL);
    expect(bootMigration(config)).toBe('same');
  });

  it('on PGlite whenever there is no database URL', () => {
    expect(bootMigration(loadConfig({}, opts))).toBe('same');
    expect(bootMigration({ databaseUrl: '', migrateDatabaseUrl: '' })).toBe('same');
  });
});
