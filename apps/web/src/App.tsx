/** Routes (contracts section 12). Assist routes need a cookie session; Desk routes are public. */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './assist/AppShell';
import { DashboardPage } from './assist/DashboardPage';
import { SessionsPage } from './assist/SessionsPage';
import { TokensPage } from './assist/tokens/TokensPage';
import { AuthProvider, RequireAuth, useAuth } from './auth/AuthContext';
import { can, type Capability } from './auth/permissions';
import { Alert, Spinner } from './components/ui';
import { DownloadRedirect } from './desk/DownloadRedirect';
import { JoinPage } from './desk/JoinPage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { PublicLayout, TextLink } from './pages/PublicLayout';
import { SignupPage } from './pages/SignupPage';

// Code splitting: the Desk room and the heavier Assist pages load on demand.
const RoomLayout = lazy(() => import('./desk/RoomLayout').then((m) => ({ default: m.RoomLayout })));
const ConsolePage = lazy(() => import('./assist/console/ConsolePage').then((m) => ({ default: m.ConsolePage })));
const AuditPage = lazy(() => import('./assist/audit/AuditPage').then((m) => ({ default: m.AuditPage })));
const ResidencyPage = lazy(() => import('./assist/ResidencyPage').then((m) => ({ default: m.ResidencyPage })));
const UsersPage = lazy(() => import('./assist/UsersPage').then((m) => ({ default: m.UsersPage })));
const BrandingPage = lazy(() => import('./assist/BrandingPage').then((m) => ({ default: m.BrandingPage })));
const PlaybooksPage = lazy(() => import('./assist/playbooks/PlaybooksPage').then((m) => ({ default: m.PlaybooksPage })));
const AccountPage = lazy(() => import('./assist/AccountPage').then((m) => ({ default: m.AccountPage })));

function RootRedirect() {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner label="Loading" />;
  return <Navigate to={status === 'authenticated' ? '/app' : '/login'} replace />;
}

/** Hides a page from roles the matrix excludes (the server enforces it regardless). */
function Allow({ cap, children }: { cap: Capability; children: ReactNode }) {
  const { me } = useAuth();
  if (!can(me?.user.role, cap)) return <Alert>Your role does not have access to this page.</Alert>;
  return <>{children}</>;
}

function NotFound() {
  return (
    <PublicLayout title="Page not found">
      <p className="mb-3 text-sm">There is nothing at this address.</p>
      <TextLink to="/">Go to the start page</TextLink>
    </PublicLayout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<Spinner label="Loading" />}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/download" element={<DownloadRedirect />} />
        <Route path="/room" element={<RoomLayout />}>
          <Route path="new" element={null} />
          <Route path=":sessionId" element={null} />
        </Route>
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="tokens" element={<Allow cap="tokens.list"><TokensPage /></Allow>} />
          <Route path="sessions" element={<Allow cap="sessions.list"><SessionsPage /></Allow>} />
          <Route path="sessions/:id" element={<Allow cap="sessions.list"><ConsolePage /></Allow>} />
          <Route path="audit" element={<Allow cap="audit.org"><AuditPage /></Allow>} />
          <Route path="residency" element={<Allow cap="residency"><ResidencyPage /></Allow>} />
          <Route path="users" element={<Allow cap="users.list"><UsersPage /></Allow>} />
          <Route path="branding" element={<Allow cap="branding"><BrandingPage /></Allow>} />
          <Route path="playbooks" element={<Allow cap="playbooks.admin"><PlaybooksPage /></Allow>} />
          <Route path="account" element={<AccountPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
    </AuthProvider>
  );
}
