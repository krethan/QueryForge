import type React from 'react';
import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput } from '@carbon/react';
import { useState, type FormEvent } from 'react';
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

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
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
      <Form onSubmit={submit} aria-label="Sign in">
        <Stack gap={6}>
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
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </Stack>
      </Form>
    </main>
  );
}
