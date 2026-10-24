import type React from 'react';
import {
  Button,
  ContentSwitcher,
  Form,
  InlineNotification,
  PasswordInput,
  Stack,
  Switch,
  TextInput,
} from '@carbon/react';
import { Login } from '@carbon/icons-react';
import { api } from '../api/client';
import type { AuthProviders } from '../api/types';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../components/ErrorNotice';

export function LoginPage() {
  const { user, login, sessionExpired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ title: string; subtitle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [method, setMethod] = useState<'local' | 'ldap'>('local');
  const ssoError = new URLSearchParams(loc.search).get('sso_error');

  useEffect(() => {
    api
      .providers()
      .then((p) => {
        setProviders(p);
        if (!p.local && p.ldap) setMethod('ldap');
      })
      .catch(() => setProviders({ local: true, oidc: null, ldap: null }));
  }, []);
  const showPassword = providers ? providers.local || Boolean(providers.ldap) : true;

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password, method);
      nav(from, { replace: true });
    } catch (err) {
      setError(describeError(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="qf-login">
      <h1>IBM i Query Reports</h1>
      <p style={{ marginBottom: '1.5rem', color: 'var(--cds-text-secondary)' }}>
        Sign in to run and manage Db2 for i reports.
      </p>
      {sessionExpired && !error && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Session expired."
          subtitle="Please sign in again."
        />
      )}
      {ssoError && !error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          role="alert"
          title="Single sign-on failed."
          subtitle={
            ssoError === 'USERNAME_TAKEN'
              ? 'A local account already uses that username. Ask an administrator to link or rename it.'
              : ssoError === 'SSO_ACCOUNT_DISABLED'
                ? 'Your account is disabled.'
                : `Please try again (${ssoError}).`
          }
        />
      )}
      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={error.title}
          subtitle={error.subtitle}
          role="alert"
        />
      )}
      {providers?.oidc && (
        <div className="qf-sso">
          <Button
            kind="primary"
            renderIcon={Login}
            href={providers.oidc.startUrl}
            className="qf-sso__button"
          >
            Sign in with {providers.oidc.label}
          </Button>
          {showPassword && <div className="qf-or">or</div>}
        </div>
      )}
      {showPassword && (
        <Form onSubmit={submit} aria-label="Sign in">
          <Stack gap={6}>
            {providers?.ldap && providers.local && (
              <ContentSwitcher
                size="md"
                selectedIndex={method === 'local' ? 0 : 1}
                onChange={({ name }: { name?: string | number }) =>
                  setMethod(name === 'ldap' ? 'ldap' : 'local')
                }
                aria-label="Account type"
              >
                <Switch name="local" text="Local account" />
                <Switch name="ldap" text={providers.ldap.label} />
              </ContentSwitcher>
            )}
            <TextInput
              id="username"
              labelText="Username"
              autoComplete="username"
              value={username}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setUsername(e.target.value)
              }
              required
            />
            <PasswordInput
              id="password"
              labelText="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setPassword(e.target.value)
              }
              required
            />
            <Button
              type="submit"
              kind={providers?.oidc ? 'tertiary' : 'primary'}
              disabled={busy || !username || !password}
            >
              {busy ? 'Signing in…' : method === 'ldap' ? 'Sign in with directory' : 'Sign in'}
            </Button>
          </Stack>
        </Form>
      )}
    </main>
  );
}
