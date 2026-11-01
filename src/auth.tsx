/**
 * Auth context (docs/accounts.md §6): who is signed in, in which mode. Loaded
 * once from GET /api/auth/me before the app store mounts, so no data request
 * fires before the server has said who the caller is. In AUTH_MODE=single the
 * server answers "single, authenticated" and nothing visible changes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AccountSummary, type AuthMe, type AuthMode } from './lib/api';

export interface AuthState {
  /** null while /api/auth/me is in flight. */
  mode: AuthMode | null;
  authenticated: boolean;
  account: AccountSummary | null;
  /** The API did not answer at all (offline), as opposed to "not signed in". */
  offline: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export const useAuth = (): AuthState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.authMe());
      setOffline(false);
    } catch {
      // No answer: treat as single mode so the app still renders its usual
      // "API offline" toast instead of a sign-in wall nobody can pass.
      setOffline(true);
      setMe({ mode: 'single', authenticated: true, account: null as unknown as AccountSummary });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(() => ({
    mode: me?.mode ?? null,
    authenticated: me?.authenticated ?? false,
    account: me && me.authenticated ? me.account : null,
    offline,
    refresh,
    signOut,
  }), [me, offline, refresh, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
