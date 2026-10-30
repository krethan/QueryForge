import {
  Button,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import { Logout } from '@carbon/icons-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

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
    </>
  );
}
