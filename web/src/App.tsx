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
import { Suspense, lazy } from 'react';
import { LoginPage } from './pages/LoginPage';

// Route-level code splitting: each page (and CodeMirror, used only by the
// report editor) is loaded on first navigation.
const AccountPage = lazy(() =>
  import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const DataSourcePage = lazy(() =>
  import('./pages/DataSourcePage').then((m) => ({ default: m.DataSourcePage })),
);
const ReportEditorPage = lazy(() =>
  import('./pages/ReportEditorPage').then((m) => ({ default: m.ReportEditorPage })),
);
const SavedReportsPage = lazy(() =>
  import('./pages/SavedReportsPage').then((m) => ({ default: m.SavedReportsPage })),
);
const SchedulesPage = lazy(() =>
  import('./pages/SchedulesPage').then((m) => ({ default: m.SchedulesPage })),
);

function RequireAuth() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading description="Loading" />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return (
    <AppShell>
      <Suspense fallback={<Loading withOverlay={false} description="Loading page" />}>
        <Outlet />
      </Suspense>
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
      { path: '/schedules', element: <SchedulesPage /> },
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
