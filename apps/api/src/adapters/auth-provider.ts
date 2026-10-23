/**
 * AuthProvider adapter (contracts section 10.3). `local` verifies argon2id hashes (memoryCost 65536, timeCost 3,
 * parallelism 1, section 6.1); `oidc` is the Phase E stub whose methods throw `not_implemented`.
 * Cookie sessions (`auth_session`) are provider independent and live in plugins/auth.ts.
 */
import argon2 from 'argon2';
import { findUserByEmail, type Db } from '@indiansassist/db';

export interface AuthProvider {
  readonly kind: 'local' | 'oidc';
  verifyPassword?(email: string, password: string): Promise<{ userId: string } | null>;
  hashPassword?(password: string): Promise<string>;
  beginLogin?(redirectUri: string): Promise<{ url: string; state: string }>;
  completeLogin?(params: Record<string, string>): Promise<{ email: string; subject: string; name: string }>;
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

export class OidcAuthProviderStub implements AuthProvider {
  readonly kind = 'oidc' as const;
  async beginLogin(): Promise<{ url: string; state: string }> {
    throw new Error('not_implemented');
  }
  async completeLogin(): Promise<{ email: string; subject: string; name: string }> {
    throw new Error('not_implemented');
  }
}

export function buildAuthProvider(kind: 'local' | 'oidc', db: Db): AuthProvider {
  return kind === 'oidc' ? new OidcAuthProviderStub() : new LocalAuthProvider(db);
}
