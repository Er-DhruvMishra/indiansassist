/**
 * Assist authentication (contracts section 6.1 / 12): `GET /auth/me` on boot; only a 401 from that call
 * means "go to /login". Other failures show a retry instead of a redirect.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { AuthResponse } from '@indiansassist/shared';
import { authApi } from '../lib/endpoints';
import { errorMessage, isApiError } from '../lib/api';
import { Alert, Button, Spinner } from '../components/ui';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export type AuthValue = {
  status: AuthStatus;
  me: AuthResponse | null;
  error: string | null;
  setMe: (me: AuthResponse | null) => void;
  refresh: () => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

/** Desk routes never call the authenticated API (they are anonymous by design). */
export function isDeskPath(path: string): boolean {
  return /^\/(join|download|room)(\/|$)/.test(path);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const desk = isDeskPath(location.pathname);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMeState] = useState<AuthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (desk) return;
    let alive = true;
    setStatus('loading');
    authApi
      .me()
      .then((r) => {
        if (!alive) return;
        setMeState(r);
        setStatus('authenticated');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setMeState(null);
        if (isApiError(e) && e.status === 401) {
          setStatus('anonymous');
        } else {
          setError(errorMessage(e));
          setStatus('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [tick, desk]);

  const setMe = useCallback((r: AuthResponse | null) => {
    setMeState(r);
    setStatus(r ? 'authenticated' : 'anonymous');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setMeState(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, me, error, setMe, refresh: () => setTick((t) => t + 1), logout }),
    [status, me, error, setMe, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Test / composition helper: provide a fixed auth value. */
export function StaticAuthProvider({ value, children }: { value: AuthValue; children: ReactNode }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Guards Assist routes; redirects to /login only after a 401 from /auth/me. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useAuth();
  const location = useLocation();
  if (status === 'loading')
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session" />
      </main>
    );
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (status === 'error')
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
        <h1 className="text-xl font-semibold">Could not reach the server</h1>
        <Alert>{error}</Alert>
        <Button onClick={refresh}>Retry</Button>
      </main>
    );
  return <>{children}</>;
}
