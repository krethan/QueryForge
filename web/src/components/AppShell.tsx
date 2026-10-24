import {
  Content,
  Header,
  HeaderContainer,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderName,
  SideNav,
  SideNavDivider,
  SideNavItems,
  SideNavLink,
  SkipToContent,
} from '@carbon/react';
import {
  Add,
  Dashboard,
  DataBase,
  DocumentMultiple_01,
  Logout,
  UserAvatar,
} from '@carbon/icons-react';
import type { ComponentType, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV: { to: string; label: string; icon: ComponentType }[] = [
  { to: '/', label: 'Dashboard', icon: Dashboard },
  { to: '/reports/new', label: 'New Report', icon: Add },
  { to: '/reports', label: 'Saved Reports', icon: DocumentMultiple_01 },
  { to: '/datasource', label: 'Data Source', icon: DataBase },
  { to: '/account', label: 'Account', icon: UserAvatar },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const isActive = (to: string) =>
    to === '/'
      ? pathname === '/'
      : to === '/reports'
        ? pathname === '/reports'
        : pathname.startsWith(to);

  return (
    <HeaderContainer
      render={({
        isSideNavExpanded,
        onClickSideNavExpand,
      }: {
        isSideNavExpanded: boolean;
        onClickSideNavExpand: () => void;
      }) => (
        <>
          <Header aria-label="IBM i Query Reports">
            <SkipToContent />
            <HeaderMenuButton
              aria-label={isSideNavExpanded ? 'Close menu' : 'Open menu'}
              onClick={onClickSideNavExpand}
              isActive={isSideNavExpanded}
              aria-expanded={isSideNavExpanded}
            />
            <HeaderName as={Link} to="/" prefix="IBM i">
              Query Reports
            </HeaderName>
            <HeaderGlobalBar>
              <HeaderGlobalAction
                aria-label={`Account: ${user?.displayName ?? ''}`}
                tooltipAlignment="end"
                onClick={() => nav('/account')}
              >
                <UserAvatar size={20} />
              </HeaderGlobalAction>
              <HeaderGlobalAction
                aria-label="Sign out"
                tooltipAlignment="end"
                onClick={async () => {
                  await logout();
                  nav('/login');
                }}
              >
                <Logout size={20} />
              </HeaderGlobalAction>
            </HeaderGlobalBar>
            <SideNav
              aria-label="Side navigation"
              expanded={isSideNavExpanded}
              isPersistent
              onSideNavBlur={onClickSideNavExpand}
              href="#main-content"
            >
              <SideNavItems>
                {NAV.map((n, i) => (
                  <span key={n.to}>
                    {i === 3 && <SideNavDivider />}
                    <SideNavLink as={Link} to={n.to} renderIcon={n.icon} isActive={isActive(n.to)}>
                      {n.label}
                    </SideNavLink>
                  </span>
                ))}
              </SideNavItems>
            </SideNav>
          </Header>
          <Content id="main-content" className="qf-content">
            {children}
          </Content>
        </>
      )}
    />
  );
}
