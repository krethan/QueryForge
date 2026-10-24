import { Loading } from '@carbon/react';
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { AccountPage } from './pages/AccountPage';
import { DashboardPage } from './pages/DashboardPage';
import { DataSourcePage } from './pages/DataSourcePage';
import { LoginPage } from './pages/LoginPage';
import { ReportEditorPage } from './pages/ReportEditorPage';
import { SavedReportsPage } from './pages/SavedReportsPage';

function RequireAuth() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading description="Loading" />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function NotFound() {
  return (
    <div className="qf-empty">
      <h2>Page not found</h2>
      <p>The page you requested does not exist.</p>
    </div>
  );
}

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/reports', element: <SavedReportsPage /> },
      { path: '/reports/new', element: <ReportEditorPage key="new" /> },
      { path: '/reports/:id', element: <ReportEditorPage /> },
      { path: '/datasource', element: <DataSourcePage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
