import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  sessionExpired: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setExpired] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser((u) => {
        if (u) setExpired(true);
        return null;
      });
    });
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Periodically refresh the session (sliding renewal) and detect expiry.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => void api.me().catch(() => undefined), 5 * 60_000);
    return () => clearInterval(t);
  }, [user]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api.login(username, password);
    setExpired(false);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, sessionExpired, login, logout }),
    [user, loading, sessionExpired, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
