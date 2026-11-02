/**
 * AuthProvider adapter (contracts section 10.3): the password provider. `local` verifies argon2id hashes (memoryCost
 * 65536, timeCost 3, parallelism 1, section 6.1). Phase E W86 retired the throwing `oidc` stub, `beginLogin` /
 * `completeLogin` and `AUTH_PROVIDER=oidc`: per-org SSO is the `SsoProvider` seam in `apps/api/src/sso/provider.ts`
 * (docs/specs/phase-e-contracts.md section 3.10). Cookie sessions (`auth_session`) live in plugins/auth.ts.
 */
import argon2 from 'argon2';
import { findUserByEmail, type Db } from '@indiansassist/db';

export interface AuthProvider {
  readonly kind: 'local';
  verifyPassword?(email: string, password: string): Promise<{ userId: string } | null>;
  hashPassword?(password: string): Promise<string>;
}

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

let dummyHash: Promise<string> | null = null;

/** A fixed hash verified against when the email is unknown, so timing does not reveal which emails exist. */
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash('ia-dummy-password-never-matches', ARGON2_OPTIONS);
  return dummyHash;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Verifies `password` against a PHC hash; a null hash still costs one verify. Never throws. */
export async function verifyPasswordHash(hash: string | null, password: string): Promise<boolean> {
  try {
    if (!hash) {
      await argon2.verify(await getDummyHash(), password);
      return false;
    }
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export class LocalAuthProvider implements AuthProvider {
  readonly kind = 'local' as const;
  constructor(private readonly db: Db) {}

  async verifyPassword(email: string, password: string): Promise<{ userId: string } | null> {
    const user = await findUserByEmail(this.db, email);
    const ok = await verifyPasswordHash(user?.passwordHash ?? null, password);
    return ok && user ? { userId: user.id } : null;
  }

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }
}

/** The password provider (section 3.10). config.ts accepts only `AUTH_PROVIDER=local`; SSO lives in apps/api/src/sso. */
export function buildAuthProvider(db: Db): AuthProvider {
  return new LocalAuthProvider(db);
}
