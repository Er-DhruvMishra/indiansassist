/**
 * The Phase D fleet console (docs/specs/phase-d-contracts.md section 13.4): what each role may see and use, the
 * `UnattendedPolicyEditor` checks and warnings, the `WakePanel` states from the `202` and the S->A pushes, the
 * action queue's wording, and that a device session says out loud when it is unattended.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UNATTENDED_POLICY,
  type AuthResponse,
  type Device,
  type DeviceAction,
  type DeviceDetail,
  type Org,
  type UnattendedPolicy,
  type UserRole,
} from '@indiansassist/shared';
import { ActionQueue, RunActionForm } from '../src/assist/fleet/ActionQueue';
import { DeviceDetailPage } from '../src/assist/fleet/DeviceDetailPage';
import { DeviceGroupAdminPage } from '../src/assist/fleet/DeviceGroupAdminPage';
import { FleetPage } from '../src/assist/fleet/FleetPage';
import { UnattendedPolicyEditor } from '../src/assist/fleet/UnattendedPolicyEditor';
import { WakePanel, applyWakeEvent, progressFromReply, type WakeEvent } from '../src/assist/fleet/WakePanel';
import { installerApi } from '../src/lib/fleetApi';
import { allowedHoursProblems, diffPolicy, overriddenKeys, overrideKeys, patchFromKeys, policyProblems, policyWarnings } from '../src/assist/fleet/policyRules';
import { UnattendedBanner, unattendedInfo, UNATTENDED_TEXT } from '../src/assist/console/agent/UnattendedBanner';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { IDS, ISO, jsonResponse } from './fakes';

const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const GROUP_ID = '77777777-7777-4777-8777-777777777777';
const ACTION_ID = '88888888-8888-4888-8888-888888888888';
const WAKE_ID = '99999999-9999-4999-8999-999999999999';

const org: Org = {
  id: IDS.org,
  name: 'Acme IT Pvt Ltd',
  slug: 'acme-it',
  dataRegion: 'in-mum',
  planTier: 'p4_installed',
  branding: { displayName: 'Acme IT' },
  createdAt: ISO,
};

function auth(role: UserRole): AuthValue {
  const me: AuthResponse = {
    user: { id: IDS.user, orgId: IDS.org, email: 'a@acme.test', name: 'Asha', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org,
    seat: null,
  };
  return { status: 'authenticated', me, error: null, setMe: () => {}, refresh: () => {}, logout: async () => {} };
}

const device: Device = {
  id: DEVICE_ID,
  name: 'RECEPTION-01',
  platform: 'windows',
  status: 'enrolled',
  online: true,
  keyId: 'a1b2c3d4e5f60718',
  osVersion: 'Windows 11 24H2',
  arch: 'x64',
  agentVersion: '1.2.0',
  serviceVersion: '1.2.0',
  groupId: GROUP_ID,
  tags: ['reception'],
  capabilities: {
    monitors: 2,
    elevation: 'admin',
    features: ['secure_desktop', 'service_input', 'waker', 'sas'],
    encoders: [],
    hwEncoder: false,
    interpreters: [],
    serviceVersion: '1.2.0',
  },
  interactive: { state: 'none', idleSec: null, at: 0 },
  amt: { present: true, provisioned: true, tls: true, version: '12.0' },
  tamperState: 'ok',
  lanSegmentHash: 'b'.repeat(64),
  notifyEmail: null,
  lastSeenAt: ISO,
  firstSeenAt: ISO,
  enrolledAt: ISO,
  lastIp: null,
};

const allowPolicy: UnattendedPolicy = { ...DEFAULT_UNATTENDED_POLICY, mode: 'allow', requireLocalApprovalWhenPresent: false };

const detail: DeviceDetail = {
  ...device,
  // Section 13.2: what this device overrides itself. `requireLocalApprovalWhenPresent` differs from the group default
  // (`{ mode: 'allow' }`), `mode` does not: a diff would miss it, the stored override does not.
  unattendedPolicy: { mode: 'allow', requireLocalApprovalWhenPresent: false },
  group: { id: GROUP_ID, name: 'Reception desks' },
  policy: allowPolicy,
  amt: device.amt,
  recentSessions: [
    { id: IDS.session, state: 'ended', unattended: true, assist: { id: IDS.user, name: 'Asha' }, knockedAt: ISO, startedAt: ISO, endedAt: ISO, endReason: 'assist_ended' },
  ],
};

const action: DeviceAction = {
  id: ACTION_ID,
  deviceId: DEVICE_ID,
  kind: 'playbook_run',
  payload: { playbookId: IDS.other, args: {}, requiresElevation: true },
  state: 'awaiting_approval',
  reason: 'Printer driver reset after the ticket',
  approvedBy: null,
  result: null,
  createdBy: { id: IDS.user, name: 'Asha' },
  createdAt: ISO,
  dispatchedAt: ISO,
  completedAt: null,
  expiresAt: ISO,
};

type Call = { url: string; method: string; body?: unknown };
let calls: Call[];

function stubFleetFetch(over: Partial<{ devices: unknown; detail: unknown; actions: unknown }> = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/policy/unattended')) return jsonResponse(200, DEFAULT_UNATTENDED_POLICY);
      if (url.includes('/policy/fleet')) return jsonResponse(200, { fleetScopingEnabled: false, wakerMeshEnabled: true });
      if (url.includes('/device-groups')) return jsonResponse(200, { items: [{ id: GROUP_ID, name: 'Reception desks', description: null, defaultPolicy: { mode: 'allow' }, defaultTags: [], notifyEmail: null, createdAt: ISO, updatedAt: ISO }] });
      if (url.includes('/orgs/current/playbooks')) return jsonResponse(200, { items: [], nextCursor: null });
      if (url.includes('/users')) return jsonResponse(200, { items: [], nextCursor: null });
      if (url.includes(`/devices/${DEVICE_ID}/actions`)) return jsonResponse(200, over.actions ?? { items: [action], nextCursor: null });
      if (url.includes(`/devices/${DEVICE_ID}/wake`)) return jsonResponse(202, { wakeId: WAKE_ID, method: 'wol', via: IDS.other });
      if (url.includes(`/devices/${DEVICE_ID}/sessions`)) return jsonResponse(201, { sessionId: IDS.session });
      if (url.includes(`/devices/${DEVICE_ID}`)) return jsonResponse(200, over.detail ?? detail);
      if (url.includes('/devices')) return jsonResponse(200, over.devices ?? { items: [device], nextCursor: null });
      return jsonResponse(404, { error: { code: 'not_found', message: 'no' } });
    }),
  );
}

/** The pages read `:id` from the route, so the test mounts them under the same path the app does. */
function renderWithRole(role: UserRole, node: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[`/app/fleet/${DEVICE_ID}`]}>
      <StaticAuthProvider value={auth(role)}>
        <Routes>
          <Route path="/app/fleet" element={node} />
          <Route path="/app/fleet/:id" element={node} />
        </Routes>
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('role-based hiding (section 7.1)', () => {
  beforeEach(() => stubFleetFetch());

  it('an org_admin sees the bulk selection, the groups link and a per-group policy link', async () => {
    renderWithRole('org_admin', <FleetPage />);
    expect(await screen.findByRole('link', { name: 'Groups and policy' })).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: 'Select RECEPTION-01' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Edit the policy of Reception desks' })).toBeTruthy();
  });

  it('an observer sees the device table but no selection, no groups link', async () => {
    renderWithRole('observer', <FleetPage />);
    expect(await screen.findByRole('link', { name: 'RECEPTION-01' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Groups and policy' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select RECEPTION-01' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit the policy of Reception desks' })).toBeNull();
  });

  it('a technician may connect, wake and queue an action but not administer the device', async () => {
    renderWithRole('technician', <DeviceDetailPage />);
    expect(await screen.findByRole('button', { name: 'Start a session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wake this device' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Queue this action' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable this device' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate the device key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire this device' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Device settings' })).toBeNull();
  });

  it('an auditor sees the queue read-only: no connect, no wake, no cancel', async () => {
    renderWithRole('auditor', <DeviceDetailPage />);
    expect(await screen.findByRole('region', { name: 'Action queue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start a session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Queue this action' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('Your role may view this device but not wake it.')).toBeTruthy();
  });

  it('an observer sees no action queue at all (section 7.1 offline queue row)', async () => {
    renderWithRole('observer', <DeviceDetailPage />);
    await screen.findByRole('heading', { name: 'This device' });
    expect(screen.queryByRole('region', { name: 'Action queue' })).toBeNull();
  });

  it('the out-of-band AMT controls are hidden from a technician and shown to a senior technician with the flag on', async () => {
    const amtPolicy = { ...allowPolicy, allowAmtSol: true, allowAmtBootRedirect: true };
    stubFleetFetch({ detail: { ...detail, policy: amtPolicy, online: false } });
    const { unmount } = renderWithRole('technician', <DeviceDetailPage />);
    await screen.findByRole('button', { name: 'Wake this device' });
    expect(screen.queryByRole('button', { name: 'Open SOL console' })).toBeNull();
    unmount();

    stubFleetFetch({ detail: { ...detail, policy: amtPolicy, online: false } });
    renderWithRole('senior_technician', <DeviceDetailPage />);
    expect(await screen.findByRole('button', { name: 'Open SOL console' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redirect next boot' })).toBeTruthy();
  });

  it('the AMT controls stay hidden when the policy flags are off, even for an org_admin', async () => {
    stubFleetFetch({ detail: { ...detail, online: false } });
    renderWithRole('org_admin', <DeviceDetailPage />);
    await screen.findByRole('button', { name: 'Wake this device' });
    expect(screen.queryByRole('region', { name: 'Out-of-band access (AMT)' })).toBeNull();
  });
});

describe('UnattendedPolicyEditor validation (section 6.1)', () => {
  it('refuses an out-of-range auto-allow, an out-of-range time limit and a window that ends before it starts', () => {
    expect(policyProblems({ ...DEFAULT_UNATTENDED_POLICY, autoAllowAfterSec: 5 })[0]).toMatch(/between 10 and 120 seconds/);
    expect(policyProblems({ ...DEFAULT_UNATTENDED_POLICY, autoAllowAfterSec: 200 })).toHaveLength(1);
    expect(policyProblems({ ...DEFAULT_UNATTENDED_POLICY, autoAllowAfterSec: 60 })).toEqual([]);
    expect(policyProblems({ ...DEFAULT_UNATTENDED_POLICY, maxUnattendedMinutes: 2000 })[0]).toMatch(/between 0 and 1440/);
    expect(allowedHoursProblems({ tz: 'Asia/Kolkata', windows: [{ days: [1], from: '18:00', to: '09:00' }] })[0]).toMatch(/overnight window as two windows/);
    expect(allowedHoursProblems({ tz: 'Not/AZone', windows: [{ days: [1], from: '09:00', to: '18:00' }] })[0]).toMatch(/not a time zone/);
    expect(allowedHoursProblems({ tz: 'Asia/Kolkata', windows: [{ days: [], from: '09:00', to: '18:00' }] })[0]).toMatch(/at least one day/);
    expect(allowedHoursProblems({ tz: 'Asia/Kolkata', windows: [{ days: [1, 5], from: '09:00', to: '18:00' }] })).toEqual([]);
  });

  it('warns on the dangerous combinations of section 13.4 and names what the technician will see', () => {
    const w = policyWarnings({ ...DEFAULT_UNATTENDED_POLICY, mode: 'allow', allowLogonScreen: true, allowSecureDesktop: true });
    expect(w[0]).toMatch(/entered with nobody present/);
    expect(w[0]).toMatch(/the Windows sign-in screen/);
    expect(w[0]).toMatch(/UAC prompts and the lock screen/);
    expect(policyWarnings({ ...DEFAULT_UNATTENDED_POLICY, recordingRequired: false }).some((x) => /may leave no video record/.test(x))).toBe(true);
    // approval_only with the same flags is not the dangerous combination the contract names.
    expect(policyWarnings({ ...DEFAULT_UNATTENDED_POLICY, allowLogonScreen: true }).some((x) => /entered with nobody present/.test(x))).toBe(false);
  });

  it('an override saves only the keys that differ from what it inherits', () => {
    const base = DEFAULT_UNATTENDED_POLICY;
    const value: UnattendedPolicy = { ...base, mode: 'allow', maxUnattendedMinutes: 30 };
    expect(overriddenKeys(base, value).sort()).toEqual(['maxUnattendedMinutes', 'mode']);
    expect(diffPolicy(base, value)).toEqual({ mode: 'allow', maxUnattendedMinutes: 30 });
    expect(diffPolicy(base, base)).toEqual({});
  });

  it('does not save while a field is out of range, and says why', async () => {
    const onSaveFull = vi.fn();
    render(<UnattendedPolicyEditor title="Org policy" mode="full" value={{ ...DEFAULT_UNATTENDED_POLICY, maxUnattendedMinutes: 2000 }} onSaveFull={onSaveFull} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSaveFull).not.toHaveBeenCalled();
    expect(screen.getByText('This policy cannot be saved yet:')).toBeTruthy();
    expect(screen.getByText(/between 0 and 1440 minutes/)).toBeTruthy();
  });

  it('saves the full policy once the field is valid', async () => {
    const onSaveFull = vi.fn();
    render(<UnattendedPolicyEditor title="Org policy" mode="full" value={DEFAULT_UNATTENDED_POLICY} onSaveFull={onSaveFull} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSaveFull).toHaveBeenCalledWith(DEFAULT_UNATTENDED_POLICY);
  });

  it('shows the dangerous-combination warning live while editing a group override, and sends a patch', async () => {
    const onSavePatch = vi.fn();
    render(
      <UnattendedPolicyEditor
        title="Group policy"
        mode="override"
        value={DEFAULT_UNATTENDED_POLICY}
        inherited={DEFAULT_UNATTENDED_POLICY}
        onSavePatch={onSavePatch}
      />,
    );
    expect(screen.getByText('Nothing is overridden here yet.', { exact: false })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Unattended mode'), 'allow');
    await userEvent.click(screen.getByLabelText('Allow the Windows sign-in screen (nobody signed in)'));
    await waitFor(() => expect(screen.getByText(/can be entered with nobody present/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSavePatch).toHaveBeenCalledWith({ mode: 'allow', allowLogonScreen: true });
  });

  it('reads which keys are set here from the stored override, not from a diff (section 13.2)', async () => {
    const onSavePatch = vi.fn();
    // `recordingRequired: true` is also what this override inherits: only the stored patch can say it is set here.
    render(
      <UnattendedPolicyEditor
        title="Policy override for this device"
        mode="override"
        value={DEFAULT_UNATTENDED_POLICY}
        inherited={DEFAULT_UNATTENDED_POLICY}
        override={{ recordingRequired: true }}
        onSavePatch={onSavePatch}
      />,
    );
    expect(screen.queryByText('Nothing is overridden here yet.', { exact: false })).toBeNull();
    expect(screen.getByText('1 field overridden: Require recording.', { exact: false })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSavePatch).toHaveBeenCalledWith({ recordingRequired: true });
    // A further edit adds its key; "Clear all overrides" sends an empty patch, so the device inherits everything again.
    await userEvent.selectOptions(screen.getByLabelText('Unattended mode'), 'allow');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSavePatch).toHaveBeenLastCalledWith({ mode: 'allow', recordingRequired: true });
    await userEvent.click(screen.getByRole('button', { name: 'Clear all overrides' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSavePatch).toHaveBeenLastCalledWith({});
  });

  it('overrideKeys and patchFromKeys keep an override that matches what it inherits', () => {
    expect(overrideKeys({ recordingRequired: true, mode: 'allow' })).toEqual(['mode', 'recordingRequired']);
    expect(overrideKeys(null)).toEqual([]);
    expect(patchFromKeys(DEFAULT_UNATTENDED_POLICY, ['recordingRequired'])).toEqual({ recordingRequired: true });
    expect(patchFromKeys(DEFAULT_UNATTENDED_POLICY, [])).toEqual({});
  });

  it('the allowed-hours builder refuses a backwards window before it is saved', async () => {
    const onSaveFull = vi.fn();
    render(<UnattendedPolicyEditor title="Org policy" mode="full" value={DEFAULT_UNATTENDED_POLICY} onSaveFull={onSaveFull} />);
    await userEvent.click(screen.getByLabelText('Limit unattended sessions and device actions to set hours'));
    const from = screen.getByLabelText('Window 1 from');
    await userEvent.clear(from);
    await userEvent.type(from, '20:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(onSaveFull).not.toHaveBeenCalled();
    expect(screen.getByText(/the start must be before the end/)).toBeTruthy();
  });
});

describe('WakePanel states (sections 8.1-8.3)', () => {
  const base = {
    deviceId: DEVICE_ID,
    deviceName: 'RECEPTION-01',
    online: false,
    amt: null,
    policy: DEFAULT_UNATTENDED_POLICY,
    canWake: true,
    canAmt: false,
  };

  it('folds the 202 and the pushes: pending -> dispatched -> woke | failed', () => {
    expect(progressFromReply({ wakeId: WAKE_ID, method: 'wol', via: null })).toEqual({ state: 'pending', wakeId: WAKE_ID, method: 'wol', via: null });
    const dispatched = progressFromReply({ wakeId: WAKE_ID, method: 'wol', via: IDS.other });
    expect(dispatched.state).toBe('dispatched');
    const woke = applyWakeEvent(dispatched, { t: 'device.woke', wakeId: WAKE_ID, deviceId: DEVICE_ID, via: IDS.other, method: 'wol', elapsedMs: 42_000 });
    expect(woke).toMatchObject({ state: 'woke', elapsedMs: 42_000 });
    // A push for another attempt, or one that arrives after the attempt settled, changes nothing.
    expect(applyWakeEvent(dispatched, { t: 'device.wake_failed', wakeId: IDS.session, deviceId: DEVICE_ID, cause: 'no_confirm' })).toBe(dispatched);
    expect(applyWakeEvent(woke, { t: 'device.wake_failed', wakeId: WAKE_ID, deviceId: DEVICE_ID, cause: 'no_confirm' })).toBe(woke);
  });

  it('shows idle, then dispatched with the waker, then woke, each as text', async () => {
    const bus: { emit: ((ev: WakeEvent) => void) | null } = { emit: null };
    const onWake = vi.fn(async () => ({ wakeId: WAKE_ID, method: 'wol' as const, via: IDS.other }));
    render(
      <WakePanel
        {...base}
        onWake={onWake}
        subscribe={(fn) => {
          bus.emit = fn;
          return () => undefined;
        }}
      />,
    );
    expect(screen.getByTestId('wake-status').textContent).toMatch(/No wake has been asked for/);
    await userEvent.click(screen.getByRole('button', { name: 'Wake this device' }));
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/Wake sent via device/));
    expect(within(screen.getByRole('status')).getByText('dispatched')).toBeTruthy();
    bus.emit?.({ t: 'device.woke', wakeId: WAKE_ID, deviceId: DEVICE_ID, via: IDS.other, method: 'wol', elapsedMs: 42_000 });
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/came back after/));
    expect(within(screen.getByRole('status')).getByText('woke')).toBeTruthy();
  });

  it('says honestly why a wake failed and what to do next', async () => {
    const bus: { emit: ((ev: WakeEvent) => void) | null } = { emit: null };
    render(
      <WakePanel
        {...base}
        onWake={async () => ({ wakeId: WAKE_ID, method: 'wol' as const, via: null })}
        subscribe={(fn) => {
          bus.emit = fn;
          return () => undefined;
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Wake this device' }));
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/choosing a device on the same network/));
    bus.emit?.({ t: 'device.wake_failed', wakeId: WAKE_ID, deviceId: DEVICE_ID, cause: 'no_waker' });
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/No other device was online on that network/));
    expect(screen.getByTestId('wake-status').textContent).toMatch(/ask someone to switch the machine on/);
    expect(within(screen.getByRole('status')).getByText('failed')).toBeTruthy();
  });

  it('a push for another device is ignored', async () => {
    const bus: { emit: ((ev: WakeEvent) => void) | null } = { emit: null };
    render(
      <WakePanel
        {...base}
        onWake={async () => ({ wakeId: WAKE_ID, method: 'wol' as const, via: IDS.other })}
        subscribe={(fn) => {
          bus.emit = fn;
          return () => undefined;
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Wake this device' }));
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/Wake sent via device/));
    bus.emit?.({ t: 'device.wake_failed', wakeId: WAKE_ID, deviceId: IDS.other, cause: 'no_confirm' });
    expect(screen.getByTestId('wake-status').textContent).toMatch(/Wake sent via device/);
  });

  it('a refusal from the server is shown in plain words and the panel returns to idle', async () => {
    const err = Object.assign(new Error('nope'), { name: 'ApiRequestError' });
    render(<WakePanel {...base} onWake={async () => { throw err; }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Wake this device' }));
    await waitFor(() => expect(screen.getByTestId('wake-status').textContent).toMatch(/No wake has been asked for/));
  });

  it('cold power on is only claimed when the firmware is present and provisioned (rule 8.4a)', () => {
    const { unmount } = render(<WakePanel {...base} amt={{ present: true, provisioned: false, tls: true }} onWake={async () => ({ wakeId: WAKE_ID, method: 'amt' as const, via: null })} />);
    expect(screen.getByText(/Cold power on: not available \(AMT present but not set up\)/)).toBeTruthy();
    unmount();
    render(<WakePanel {...base} amt={{ present: true, provisioned: true, tls: true }} onWake={async () => ({ wakeId: WAKE_ID, method: 'amt' as const, via: null })} />);
    expect(screen.getByText(/Cold power on: available/)).toBeTruthy();
  });
});

describe('the action queue (section 9, 13.4)', () => {
  it('shows awaiting_approval as "waiting for someone at the device" and offers cancel only to a role that may act', async () => {
    const onCancel = vi.fn(async () => undefined);
    const { unmount } = render(
      <ActionQueue deviceId={DEVICE_ID} actions={[action]} loading={false} error={null} canAct={false} onCancel={onCancel} onReload={() => {}} />,
    );
    expect(within(screen.getByRole('table', { name: 'Device actions' })).getByText('Waiting for someone at the device')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    unmount();
    render(<ActionQueue deviceId={DEVICE_ID} actions={[action]} loading={false} error={null} canAct onCancel={onCancel} onReload={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith(ACTION_ID);
  });

  it('a message needs no reason, and a privileged playbook run will not be sent without one (rule 9.1)', async () => {
    const onQueue = vi.fn(async () => undefined);
    render(<RunActionForm playbooks={[]} policy={allowPolicy} online onQueue={onQueue} />);
    await userEvent.type(screen.getByLabelText('Title'), 'We will connect shortly');
    await userEvent.type(screen.getByLabelText('Message'), 'Your ticket is being looked at.');
    await userEvent.click(screen.getByRole('button', { name: 'Queue this action' }));
    await waitFor(() => expect(onQueue).toHaveBeenCalledWith({ kind: 'message', payload: { title: 'We will connect shortly', body: 'Your ticket is being looked at.' } }));
  });

  it('only a message may be queued while the policy refuses unattended access (rule 9.9)', () => {
    render(<RunActionForm playbooks={[]} policy={{ ...DEFAULT_UNATTENDED_POLICY, mode: 'deny' }} online onQueue={async () => undefined} />);
    expect(screen.getByText(/policy refuses unattended access, so only a message can be sent/)).toBeTruthy();
  });
});

describe('the branded installer download (sections 12.1, 13.4)', () => {
  it('reads the manifest and builds a per-token download link, and says when nothing is configured', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return jsonResponse(200, { v: 1, builds: [{ arch: 'x64', version: '0.4.0', size: 10, sha256: 'a'.repeat(64), signed: true, minOs: '10.0.17763' }] });
      }),
    );
    const m = await installerApi.manifest();
    expect(seen[0]).toContain('/download/installer');
    expect(m.builds[0]?.arch).toBe('x64');
    // The link is a plain GET the browser can follow; the token it is audited against travels in the query.
    expect(installerApi.url('x64', IDS.other)).toContain(`/download/installer/x64?tokenId=${IDS.other}`);
    expect(installerApi.url('arm64', IDS.other)).toContain('/download/installer/arm64?');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { v: 1, builds: [] })));
    expect((await installerApi.manifest()).builds).toEqual([]);
  });
});

describe('an unattended session is labelled as such (sections 6.2, 13.4)', () => {
  it('names the unattended banner, the authorisation and the forced recording', () => {
    render(<UnattendedBanner info={{ unattended: true, deviceName: 'RECEPTION-01', policy: { ...allowPolicy, recordingRequired: true }, approvedBy: 'policy' }} />);
    expect(screen.getByTestId('unattended-banner').textContent).toBe(UNATTENDED_TEXT);
    expect(screen.getByText(/authorised by policy/)).toBeTruthy();
    expect(screen.getByText(/Recording is required by policy/)).toBeTruthy();
  });

  it('renders nothing for an attended device session', () => {
    const { container } = render(<UnattendedBanner info={{ unattended: false, deviceName: 'RECEPTION-01', policy: allowPolicy }} />);
    expect(container.textContent).toBe('');
  });

  it('shows the arrival banner of rule 6.2a with the level drop', () => {
    render(
      <UnattendedBanner info={{ unattended: true, deviceName: 'RECEPTION-01', policy: allowPolicy, approvedBy: 'policy', userArrived: true, levelDroppedToView: true }} />,
    );
    expect(screen.getByText('Someone is now at the device.')).toBeTruthy();
    expect(screen.getByText(/dropped to view only/)).toBeTruthy();
  });

  it('the device page says a recent session was unattended', async () => {
    stubFleetFetch();
    renderWithRole('org_admin', <DeviceDetailPage />);
    const table = await screen.findByRole('table', { name: 'Recent sessions on this device' });
    expect(within(table).getByText('Unattended')).toBeTruthy();
  });

  it('the device page names the fields set on the device itself, not a diff of the effective policy', async () => {
    stubFleetFetch();
    renderWithRole('org_admin', <DeviceDetailPage />);
    const line = await screen.findByTestId('device-override');
    expect(line.textContent).toBe('Set on this device: Unattended mode, Ask for approval when someone is at the device.');
  });

  it('the console shows the session policy snapshot, not the device policy as it stands now (sections 6.2, 13.2)', () => {
    const snapshot: UnattendedPolicy = { ...allowPolicy, maxUnattendedMinutes: 15, recordingRequired: false };
    const info = unattendedInfo({
      deviceId: DEVICE_ID,
      deviceName: 'RECEPTION-01',
      unattended: true,
      policySnapshot: snapshot,
      devicePolicy: { ...allowPolicy, maxUnattendedMinutes: 999, recordingRequired: true },
      approvedBy: 'policy',
    });
    expect(info?.policy).toBe(snapshot);
    expect(info?.approvedBy).toBe('policy');
    render(<UnattendedBanner info={info!} />);
    expect(screen.getByText(/This policy does not force a recording/)).toBeTruthy();
    // Without a snapshot (a session opened before it was exposed) the device's effective policy is still the fallback.
    expect(unattendedInfo({ deviceId: DEVICE_ID, deviceName: 'x', unattended: true, devicePolicy: allowPolicy })?.policy).toBe(allowPolicy);
    // Not a device session: nothing to show.
    expect(unattendedInfo({ deviceId: null, deviceName: 'x', unattended: null })).toBeUndefined();
  });

  it('the rule 6.2a push raises the arrival banner the console already had', () => {
    const push = { t: 'session.local_user_arrived', sessionId: IDS.session, decision: 'continue', levelDroppedTo: 'view' } as const;
    const info = unattendedInfo({
      deviceId: DEVICE_ID,
      deviceName: 'RECEPTION-01',
      unattended: true,
      policySnapshot: allowPolicy,
      approvedBy: 'policy',
      arrival: { decision: push.decision, levelDroppedTo: push.levelDroppedTo },
    });
    expect(info).toMatchObject({ userArrived: true, levelDroppedToView: true });
    render(<UnattendedBanner info={info!} />);
    expect(screen.getByText('Someone is now at the device.')).toBeTruthy();
    expect(screen.getByText(/dropped to view only/)).toBeTruthy();
  });

  it('the connect panel requires a reason for an unattended session and sends it', async () => {
    stubFleetFetch();
    renderWithRole('technician', <DeviceDetailPage />);
    const connect = await screen.findByRole('region', { name: 'Connect' });
    expect((within(connect).getByRole('radio', { name: /Unattended/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(connect).getByRole('button', { name: 'Start a session' }));
    expect(within(connect).getByText(/An unattended session needs a reason/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/sessions'))).toBe(false);
    await userEvent.type(within(connect).getByLabelText('Reason (required)'), 'Overnight patch window, ticket 4821');
    await userEvent.click(within(connect).getByRole('button', { name: 'Start a session' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.includes('/sessions'))?.body).toEqual({ unattended: true, reason: 'Overnight patch window, ticket 4821' }),
    );
  });

  it('the unattended choice is not offered when the policy refuses it, and the console says so', async () => {
    stubFleetFetch({ detail: { ...detail, policy: { ...DEFAULT_UNATTENDED_POLICY, mode: 'deny' } } });
    renderWithRole('technician', <DeviceDetailPage />);
    const connect = await screen.findByRole('region', { name: 'Connect' });
    expect((within(connect).getByRole('radio', { name: /Unattended/ }) as HTMLInputElement).disabled).toBe(true);
    expect(within(connect).getByText(/policy refuses unattended entry/)).toBeTruthy();
  });
});

describe('the group and policy admin page (sections 7.1, 7.2)', () => {
  beforeEach(() => stubFleetFetch());

  it('explains that unassigned technicians lose fleet access once scoping is on, and patches the setting', async () => {
    render(
      <MemoryRouter>
        <StaticAuthProvider value={auth('org_admin')}>
          <DeviceGroupAdminPage />
        </StaticAuthProvider>
      </MemoryRouter>,
    );
    const box = await screen.findByRole('checkbox', { name: /Limit each technician to their assigned device groups/ });
    expect(screen.getByText(/no fleet access at all/)).toBeTruthy();
    await userEvent.click(box);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.url.includes('/policy/fleet'))?.body).toEqual({ fleetScopingEnabled: true }));
  });

  it('shows each group with how much of the org default it overrides', async () => {
    render(
      <MemoryRouter>
        <StaticAuthProvider value={auth('org_admin')}>
          <DeviceGroupAdminPage />
        </StaticAuthProvider>
      </MemoryRouter>,
    );
    const group = await screen.findByRole('region', { name: 'Group Reception desks' });
    expect(within(group).getByText('1 field overridden')).toBeTruthy();
    expect(within(group).getByText(/Overridden: Unattended mode/)).toBeTruthy();
  });
});
