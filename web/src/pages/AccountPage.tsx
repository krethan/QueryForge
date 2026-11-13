import {
  Button,
  InlineNotification,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Toggle,
} from '@carbon/react';
import { Logout } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AccountSettings } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice } from '../components/ErrorNotice';

/** "E-mail me about shares" (migration 015): being given access, role changes, end dates. */
export function ShareEmailSetting() {
  const [info, setInfo] = useState<AccountSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .getAccountSettings()
      .then(setInfo)
      .catch((e) => setError(e));
  }, []);
  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.putAccountSettings({ shareEmails: on }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qf-section qf-account-notify">
      <h2>Notifications</h2>
      <ErrorNotice error={error} />
      {info && (
        <>
          <Toggle
            id="account-share-emails"
            labelText="E-mail me about shares"
            labelA="Off"
            labelB="On"
            toggled={info.settings.shareEmails}
            disabled={busy}
            onToggle={(on: boolean) => void change(on)}
          />
          <p className="qf-muted">
            When someone shares a report or folder with you or changes your access, and a few days
            before a share you made ends.
          </p>
          {!info.mailConfigured && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="E-mail isn't set up on this server"
              subtitle="No share e-mails are sent at the moment. Your choice is kept for when it is."
            />
          )}
          {info.mailConfigured && !info.hasEmail && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="No e-mail address"
              subtitle="Your account has no e-mail address, so these e-mails can't reach you."
            />
          )}
        </>
      )}
    </div>
  );
}

export function AccountPage() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  if (!user) return null;
  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Account</h1>
          <p>Application accounts are managed by an administrator with the user:create script.</p>
        </div>
        <Button
          kind="secondary"
          renderIcon={Logout}
          onClick={async () => {
            await logout();
            nav('/login');
          }}
        >
          Sign out
        </Button>
      </div>
      <div className="qf-section">
        <h2>About Uncle Bob</h2>
        <p>Bob's your uncle — Uncle Bob is a browser-based SQL reporting tool for IBM i.</p>
      </div>
      <StructuredListWrapper aria-label="Account details">
        <StructuredListBody>
          <StructuredListRow>
            <StructuredListCell noWrap>Display name</StructuredListCell>
            <StructuredListCell>{user.displayName}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Username</StructuredListCell>
            <StructuredListCell>{user.username}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Role</StructuredListCell>
            <StructuredListCell>
              {user.role === 'ADMIN' ? 'Administrator' : 'User'}
            </StructuredListCell>
          </StructuredListRow>
        </StructuredListBody>
      </StructuredListWrapper>
      <ShareEmailSetting />
    </>
  );
}
