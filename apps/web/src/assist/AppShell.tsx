/** /app layout: header (org, role, region badge, logout), navigation, knock toasts, one signaling socket. */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { can, type Capability } from '../auth/permissions';
import { ShortcutHelp } from '../components/ShortcutHelp';
import { Badge, Button, cx } from '../components/ui';
import { APP_NAME } from '../config';
import { fmtRoleName, regionLabel } from '../lib/format';
import { AssistSignalProvider, useAssistSignal } from './signal/AssistSignalProvider';
import { KnockToasts } from './signal/KnockPanel';

const NAV: { to: string; label: string; cap?: Capability; end?: boolean }[] = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/tokens', label: 'Tokens', cap: 'tokens.list' },
  { to: '/app/sessions', label: 'Sessions', cap: 'sessions.list' },
  { to: '/app/audit', label: 'Audit', cap: 'audit.org' },
  { to: '/app/residency', label: 'Residency', cap: 'residency' },
  { to: '/app/users', label: 'Users', cap: 'users.list' },
  { to: '/app/branding', label: 'Branding', cap: 'branding' },
  { to: '/app/playbooks', label: 'Playbooks', cap: 'playbooks.admin' },
  { to: '/app/account', label: 'Account' },
];

function SignalBadge() {
  const s = useAssistSignal();
  if (!s) return null;
  const tone = s.status === 'open' ? 'green' : s.status === 'reconnecting' || s.status === 'connecting' ? 'amber' : 'red';
  const text = s.status === 'open' ? 'Online' : s.status === 'reconnecting' ? 'Reconnecting' : s.status === 'connecting' ? 'Connecting' : 'Offline';
  return (
    <Badge tone={tone}>
      <span className="sr-only">Signaling: </span>
      {text}
    </Badge>
  );
}

export function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!me) return null;
  const role = me.user.role;
  const items = NAV.filter((n) => !n.cap || can(role, n.cap));

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <AssistSignalProvider enabled={can(role, 'ws.assist')}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-slate-900">
        Skip to content
      </a>
      <header className="no-print border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2">
          <span className="text-lg font-bold text-teal-800 dark:text-teal-300">{APP_NAME}</span>
          <span className="hidden h-5 w-px bg-slate-300 sm:block dark:bg-slate-700" aria-hidden="true" />
          <span className="font-medium" title="Organisation">
            {me.org.branding.displayName ?? me.org.name}
          </span>
          <Badge tone="blue">
            <span className="sr-only">Data region: </span>
            {regionLabel(me.org.dataRegion)}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <SignalBadge />
            <span className="hidden text-sm sm:inline">
              {me.user.name} <span className="text-slate-600 dark:text-slate-400">({fmtRoleName(role)})</span>
            </span>
            <ShortcutHelp />
            <Button variant="secondary" size="sm" onClick={() => void onLogout()}>
              Log out
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="sm:hidden"
              aria-expanded={menuOpen}
              aria-controls="main-nav"
              onClick={() => setMenuOpen((o) => !o)}
            >
              Menu
            </Button>
          </div>
        </div>
        <nav id="main-nav" aria-label="Main" className={cx('mx-auto max-w-7xl px-4', menuOpen ? 'block' : 'hidden sm:block')}>
          <ul className="flex flex-col gap-1 pb-2 sm:flex-row sm:gap-1">
            {items.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    cx(
                      'block rounded-md px-3 py-1.5 text-sm font-medium',
                      isActive
                        ? 'bg-teal-700 text-white'
                        : 'text-slate-800 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800',
                    )
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      <KnockToasts />
    </AssistSignalProvider>
  );
}
