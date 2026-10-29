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
  TableSplit,
  Time,
  UserAvatar,
} from '@carbon/icons-react';
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV: { to: string; label: string; icon: ComponentType }[] = [
  { to: '/', label: 'Dashboard', icon: Dashboard },
  { to: '/reports/new', label: 'New Report', icon: Add },
  { to: '/report-builder', label: 'Report Builder', icon: TableSplit },
  { to: '/reports', label: 'Saved Reports', icon: DocumentMultiple_01 },
  { to: '/schedules', label: 'Schedules', icon: Time },
  { to: '/datasource', label: 'Data Source', icon: DataBase },
  { to: '/account', label: 'Account', icon: UserAvatar },
];

const PRODUCT_NAME = 'Uncle Bob';

/** Browser tab title: the page name followed by the product name. */
export function pageTitle(pathname: string): string {
  const page =
    pathname === '/'
      ? 'Dashboard'
      : pathname === '/reports/new'
        ? 'New Report'
        : /^\/reports\/[^/]+$/.test(pathname)
          ? 'Report'
          : pathname === '/reports'
            ? 'Saved Reports'
            : pathname === '/report-builder'
              ? 'Report Builder'
              : pathname === '/schedules'
                ? 'Schedules'
                : pathname === '/datasource'
                  ? 'Data Source'
                  : pathname === '/account'
                    ? 'Account'
                    : null;
  return page ? `${page} — ${PRODUCT_NAME}` : PRODUCT_NAME;
}

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

  useEffect(() => {
    document.title = pageTitle(pathname);
  }, [pathname]);

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
          <Header aria-label="Uncle Bob">
            <SkipToContent />
            <HeaderMenuButton
              aria-label={isSideNavExpanded ? 'Close menu' : 'Open menu'}
              onClick={onClickSideNavExpand}
              isActive={isSideNavExpanded}
              aria-expanded={isSideNavExpanded}
            />
            <HeaderName as={Link} to="/" prefix="Uncle">
              Bob
            </HeaderName>
            <span className="qf-brand-tagline">Bob's your uncle</span>
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
                    {i === 5 && <SideNavDivider />}
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
