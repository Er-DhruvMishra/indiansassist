#!/usr/bin/env node
// Writes packages/shared/test/fixtures/fleet/*.json (docs/specs/phase-d-contracts.md section 3.8 and the sealing
// convention) from fixed keys with the BUILT @indiansassist/shared: the eight device signature domains (signing input
// hex + Ed25519 signature) and sealing vectors (fixed ephemeral secret and nonce). Both the TS tests and the Rust
// `ia_core::devsig` / `ia_core::seal` tests reproduce them. `--check` fails when the committed files differ.
//
//   pnpm --filter @indiansassist/shared build && node scripts/gen-fleet-fixtures.mjs [--check]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShared } from './smoke/shared.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages', 'shared', 'test', 'fixtures', 'fleet');
const s = await loadShared();

const hex = (b) => Buffer.from(b).toString('hex');
const fill = (n, v) => new Uint8Array(n).fill(v);
const b64u = (b) => s.base64urlEncode(b);

const identitySeed = fill(32, 0x11);
const newIdentitySeed = fill(32, 0x22);
const kexSecret = fill(32, 0x33);
const newKexSecret = fill(32, 0x44);
const deviceId = '0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a';
const sessionId = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const tokenId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const actionId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const devicePublicKey = s.devicePublicKeyOf(identitySeed);
const newPublicKey = s.devicePublicKeyOf(newIdentitySeed);
const deviceKexPublicKey = s.kexPublicKeyOf(kexSecret);
const newKexPublicKey = s.kexPublicKeyOf(newKexSecret);
const serverChallenge = b64u(fill(32, 0x55));
const nonce = b64u(fill(16, 0x66));
const rotationNonce = b64u(fill(16, 0x77));
const oldKeyId = s.kidOf(s.base64urlDecode(devicePublicKey));
const tamperEvent = { id: '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901', cause: 'stopped', at: '2026-11-01T10:00:00.000Z', detail: 'service stopped by SYSTEM' };

const cases = [
  ['ia-enroll-v1', identitySeed, s.deviceSigInput.enroll({ tokenId, devicePublicKey, deviceKexPublicKey }), { tokenId, devicePublicKey, deviceKexPublicKey }],
  ['ia-dev-v1', identitySeed, s.deviceSigInput.hello({ deviceId, serverChallenge, nonce }), { deviceId, serverChallenge, nonce }],
  ['ia-rot-v1', identitySeed, s.deviceSigInput.rotate({ deviceId, rotationNonce, newPublicKey, newKexPublicKey }), { deviceId, rotationNonce, newPublicKey, newKexPublicKey }],
  ['ia-rot-new-v1', newIdentitySeed, s.deviceSigInput.rotateNew({ deviceId, rotationNonce, oldKeyId }), { deviceId, rotationNonce, oldKeyId }],
  ['ia-dereg-v1', identitySeed, s.deviceSigInput.deregister({ deviceId, ts: 1793520000000, nonce }), { deviceId, ts: 1793520000000, nonce }],
  ['ia-tamper-v1', identitySeed, s.deviceSigInput.tamper({ deviceId, event: tamperEvent }), { deviceId, event: tamperEvent }],
  [
    'ia-action-v1',
    identitySeed,
    s.deviceSigInput.action({ deviceId, actionId, state: 'done', approvedBy: 'policy', result: { exit: 0, ranAs: 'admin' } }),
    { deviceId, actionId, state: 'done', approvedBy: 'policy', result: { exit: 0, ranAs: 'admin' } },
  ],
  [
    'ia-sas-v1',
    identitySeed,
    s.deviceSigInput.sas({ sessionId, gen: 1, sas: '042917', deskFpr: 'a'.repeat(64), assistFpr: 'b'.repeat(64) }),
    { sessionId, gen: 1, sas: '042917', deskFpr: 'a'.repeat(64), assistFpr: 'b'.repeat(64) },
  ],
];

const signatures = {
  v: 1,
  keys: {
    identitySeedHex: hex(identitySeed),
    devicePublicKey,
    newIdentitySeedHex: hex(newIdentitySeed),
    newPublicKey,
    kexSecretHex: hex(kexSecret),
    deviceKexPublicKey,
    newKexPublicKey,
    keyId: oldKeyId,
  },
  vectors: cases.map(([domain, seed, input, fields]) => ({
    domain,
    fields,
    signingInputHex: hex(input),
    sig: s.signDeviceInput(input, seed),
  })),
};

const seals = {
  v: 1,
  kexSecretHex: hex(kexSecret),
  kexPublicKey: deviceKexPublicKey,
  deviceId,
  vectors: [
    ['wake-mac', '0a1b2c3d4e5f', 0x01],
    ['amt-cred', '{"user":"admin","password":"P@ss"}', 0x02],
    ['vault-secret', 'secret-value-123', 0x03],
  ].map(([purpose, plaintext, v]) => {
    const ephSecret = fill(32, 0x80 + v);
    const nonceBytes = fill(24, 0x90 + v);
    return { purpose, plaintext, ephSecretHex: hex(ephSecret), sealed: s.sealToDevice(deviceKexPublicKey, deviceId, purpose, plaintext, { ephSecret, nonce: nonceBytes }) };
  }),
};

// ---------------------------------------------------------------- decisions.json (sections 6.1, 6.2, rule 9.9)
//
// The policy decision is implemented twice: in `packages/shared/src/fleet/policy.ts`, which the api calls at session
// open and at dispatch, and in `ia_core::policy`, which the installed service re-runs on the device before it acts
// (rule 9.9). This file is the only thing holding them together: it is generated from the TypeScript and replayed by
// `packages/shared/test/fleet-policy.test.ts` and `agent/crates/ia-core/tests/fleet_vectors.rs`. A change on either
// side that is not a change on both fails one of those two tests, and `--check` fails if the file was not regenerated.

/** A full policy: the org default of section 6.1 with the named keys overridden. */
const pol = (over = {}) => ({ ...s.DEFAULT_UNATTENDED_POLICY, ...over });

const istOffice = { tz: 'Asia/Kolkata', windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] };
const istOvernight = {
  tz: 'Asia/Kolkata',
  windows: [
    { days: [1], from: '22:00', to: '23:59' },
    { days: [2], from: '00:00', to: '06:00' },
  ],
};
const utcNights = { tz: 'UTC', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '06:00' }] };

// Named policies the case tables refer to, so the cases stay readable and the Rust side parses one shape.
const policies = {
  default: pol(),
  deny: pol({ mode: 'deny' }),
  approval_only: pol(),
  allow_ask: pol({ mode: 'allow', requireLocalApprovalWhenPresent: true }),
  allow_ask_countdown: pol({ mode: 'allow', requireLocalApprovalWhenPresent: true, autoAllowAfterSec: 30 }),
  allow_quiet: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false }),
  allow_logon: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false, allowLogonScreen: true }),
  allow_office_hours: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false, allowedHours: istOffice }),
  allow_no_privileged: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false, allowPrivileged: false }),
  allow_office_no_privileged: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false, allowPrivileged: false, allowedHours: istOffice }),
  allow_no_recording: pol({ mode: 'allow', requireLocalApprovalWhenPresent: false, recordingRequired: false }),
  deny_office_hours: pol({ mode: 'deny', allowedHours: istOffice }),
};

// Fixed instants, so the fixture is deterministic. 2026-11-02 is a Monday.
const MON_0430Z = '2026-11-02T04:30:00.000Z'; // Monday 10:00 IST: inside office hours
const MON_0300Z = '2026-11-02T03:00:00.000Z'; // Monday 08:30 IST: before them
const MON_1400Z = '2026-11-02T14:00:00.000Z'; // Monday 19:30 IST: after them
const SUN_0430Z = '2026-11-01T04:30:00.000Z'; // Sunday 10:00 IST: not a listed day
const MON_1700Z = '2026-11-02T17:00:00.000Z'; // Monday 22:30 IST: inside the overnight window
const MON_2000Z = '2026-11-02T20:00:00.000Z'; // Tuesday 01:30 IST: inside its second half

const mergeCases = [
  { name: 'nothing set anywhere is the safe org default', org: null, group: null, device: null },
  { name: 'org opts into allow, the group narrows it, the device narrows it further', org: { mode: 'allow' }, group: { allowInputLock: true, maxUnattendedMinutes: 60 }, device: { maxUnattendedMinutes: 30 } },
  { name: 'the device wins over the group, which wins over the org', org: { mode: 'allow', notifyLocalUser: false }, group: { mode: 'approval_only' }, device: { mode: 'deny' } },
  { name: 'a group countdown an explicit device null clears', org: { mode: 'allow' }, group: { autoAllowAfterSec: 60 }, device: { autoAllowAfterSec: null } },
  { name: 'allowed hours set by the group and cleared by the device', org: { mode: 'allow' }, group: { allowedHours: istOffice }, device: { allowedHours: null } },
  { name: 'allowed hours inherited from the org when nothing else sets them', org: { mode: 'allow', allowedHours: utcNights }, group: null, device: null },
  { name: 'every service-grade flag turned on by the group', org: { mode: 'allow' }, group: { allowLogonScreen: true, allowSecureDesktop: true, allowInputLock: true, allowPrivacyScreen: true, allowAmtSol: true, allowAmtBootRedirect: true }, device: null },
  { name: 'a countdown below the floor is refused', org: null, group: null, device: { autoAllowAfterSec: 5 }, invalid: true },
  { name: 'a countdown above the ceiling is refused', org: null, group: null, device: { autoAllowAfterSec: 240 }, invalid: true },
  { name: 'more unattended minutes than the cap is refused', org: null, group: null, device: { maxUnattendedMinutes: 2000 }, invalid: true },
  { name: 'a window that ends before it starts is refused', org: null, group: { allowedHours: { tz: 'Asia/Kolkata', windows: [{ days: [1], from: '18:00', to: '09:00' }] } }, device: null, invalid: true },
  { name: 'an unknown time zone is refused', org: null, group: { allowedHours: { tz: 'Mars/Olympus', windows: [{ days: [1], from: '09:00', to: '18:00' }] } }, device: null, invalid: true },
  { name: 'a repeated weekday is refused', org: null, group: { allowedHours: { tz: 'UTC', windows: [{ days: [1, 1], from: '09:00', to: '18:00' }] } }, device: null, invalid: true },
];

const merge = mergeCases.map((c) => {
  // The org default is itself a full policy (section 6.1), so an org patch is applied over the shipped default first.
  const orgDefault = c.org ? pol(c.org) : null;
  const run = () => s.resolveUnattendedPolicy({ unattendedPolicy: c.device }, { defaultPolicy: c.group }, orgDefault);
  if (c.invalid) {
    let threw = false;
    try {
      run();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`merge case "${c.name}" was expected to be invalid`);
    return { name: c.name, org: c.org ?? null, group: c.group ?? null, device: c.device ?? null, invalid: true };
  }
  const expect = run();
  return { name: c.name, org: c.org ?? null, group: c.group ?? null, device: c.device ?? null, expect };
});

const windowCases = [
  { name: 'office hours, Monday 10:00 in its own zone', allowedHours: istOffice, now: MON_0430Z },
  { name: 'office hours, half an hour before they open', allowedHours: istOffice, now: MON_0300Z },
  { name: 'office hours, after they close', allowedHours: istOffice, now: MON_1400Z },
  { name: 'office hours on a day they do not cover', allowedHours: istOffice, now: SUN_0430Z },
  { name: 'an overnight window written as two, first half', allowedHours: istOvernight, now: MON_1700Z },
  { name: 'an overnight window written as two, second half', allowedHours: istOvernight, now: MON_2000Z },
  { name: 'a UTC night window at 04:30 UTC', allowedHours: utcNights, now: MON_0430Z },
  { name: 'a UTC night window at 14:00 UTC', allowedHours: utcNights, now: MON_1400Z },
  { name: 'no allowed hours at all', allowedHours: null, now: MON_1400Z },
];

const windows = windowCases.map((c) => {
  const policy = pol({ allowedHours: c.allowedHours });
  const next = s.nextPolicyWindowStart(policy, new Date(c.now));
  return {
    name: c.name,
    allowedHours: c.allowedHours,
    now: c.now,
    inside: s.isWithinPolicyWindow(policy, new Date(c.now)),
    nextStart: next ? next.toISOString() : null,
  };
});

const sessionCases = [
  { name: 'attended, somebody present: the C consent window', policy: 'default', unattended: false, interactive: 'active', now: MON_1400Z },
  { name: 'attended, screen locked: nobody to ask', policy: 'default', unattended: false, interactive: 'locked', now: MON_1400Z },
  { name: 'attended, nobody logged on', policy: 'default', unattended: false, interactive: 'none', now: MON_1400Z },
  { name: 'attended ignores the allowed hours', policy: 'allow_office_hours', unattended: false, interactive: 'active', now: MON_1400Z },
  { name: 'unattended refused outright by the policy', policy: 'deny', unattended: true, interactive: 'active', now: MON_1400Z },
  { name: 'unattended refused outright even outside the hours (mode is checked first)', policy: 'deny_office_hours', unattended: true, interactive: 'locked', now: MON_1400Z },
  { name: 'approval only, somebody present: the approval card', policy: 'approval_only', unattended: true, interactive: 'active', now: MON_1400Z },
  { name: 'approval only, nobody present: nobody can approve', policy: 'approval_only', unattended: true, interactive: 'locked', now: MON_1400Z },
  { name: 'allow, present, approval required when present', policy: 'allow_ask', unattended: true, interactive: 'active', now: MON_1400Z },
  { name: 'allow, present, approval not required: straight in', policy: 'allow_quiet', unattended: true, interactive: 'active', now: MON_1400Z },
  { name: 'allow, locked: nobody to disturb', policy: 'allow_ask', unattended: true, interactive: 'locked', now: MON_1400Z },
  { name: 'allow, nobody logged on, logon screen not permitted', policy: 'allow_quiet', unattended: true, interactive: 'none', now: MON_1400Z },
  { name: 'allow, nobody logged on, logon screen permitted', policy: 'allow_logon', unattended: true, interactive: 'none', now: MON_1400Z },
  { name: 'an unknown interactive state counts as nobody logged on', policy: 'allow_quiet', unattended: true, interactive: null, now: MON_1400Z },
  { name: 'allow, inside the allowed hours', policy: 'allow_office_hours', unattended: true, interactive: 'locked', now: MON_0430Z },
  { name: 'allow, outside the allowed hours', policy: 'allow_office_hours', unattended: true, interactive: 'locked', now: MON_1400Z },
  { name: 'the hours are checked after the mode table, so a refusal still names them', policy: 'allow_office_hours', unattended: true, interactive: 'active', now: MON_1400Z },
  { name: 'recording required and no recorder on this node', policy: 'allow_quiet', unattended: true, interactive: 'locked', now: MON_1400Z, recorderAvailable: false },
  { name: 'recording required, a recorder is there', policy: 'allow_quiet', unattended: true, interactive: 'locked', now: MON_1400Z, recorderAvailable: true },
  { name: 'recording not required, no recorder', policy: 'allow_no_recording', unattended: true, interactive: 'locked', now: MON_1400Z, recorderAvailable: false },
  { name: 'an attended session also needs the recorder the policy requires', policy: 'default', unattended: false, interactive: 'active', now: MON_1400Z, recorderAvailable: false },
];

const sessions = sessionCases.map((c) => ({
  name: c.name,
  policy: c.policy,
  unattended: c.unattended,
  interactive: c.interactive ?? null,
  now: c.now,
  recorderAvailable: c.recorderAvailable ?? null,
  expect: s.decideDeviceSession({
    unattended: c.unattended,
    policy: policies[c.policy],
    interactive: c.interactive ? { state: c.interactive } : null,
    now: new Date(c.now),
    ...(c.recorderAvailable === undefined ? {} : { recorderAvailable: c.recorderAvailable }),
  }),
}));

const actionCases = [
  { name: 'a message is never gated, at the POST', stage: 'queue', kind: 'message', policy: 'deny', interactive: 'active', now: MON_1400Z },
  { name: 'a message runs with the toast when somebody is there', stage: 'dispatch', kind: 'message', policy: 'deny', interactive: 'active', now: MON_1400Z },
  { name: 'a message runs quietly when nobody is there', stage: 'dispatch', kind: 'message', policy: 'deny', interactive: 'none', now: MON_1400Z },
  { name: 'a message ignores the allowed hours', stage: 'dispatch', kind: 'message', policy: 'allow_office_hours', interactive: 'locked', now: MON_1400Z },
  { name: 'deny refuses a playbook at the POST', stage: 'queue', kind: 'playbook_run', policy: 'deny', interactive: 'active', now: MON_1400Z },
  { name: 'deny refuses a file push at the POST', stage: 'queue', kind: 'file_push', policy: 'deny', interactive: 'none', now: MON_1400Z },
  { name: 'deny refuses a print at the POST', stage: 'queue', kind: 'print', policy: 'deny', interactive: 'none', now: MON_1400Z },
  { name: 'allow queues a playbook', stage: 'queue', kind: 'playbook_run', policy: 'allow_quiet', interactive: 'none', now: MON_1400Z },
  { name: 'approval only queues a playbook too', stage: 'queue', kind: 'playbook_run', policy: 'approval_only', interactive: 'none', now: MON_1400Z },
  { name: 'a privileged playbook is still queued under a policy that forbids it', stage: 'queue', kind: 'playbook_run', privileged: true, policy: 'allow_no_privileged', interactive: 'none', now: MON_1400Z },
  { name: 'deny reached after queueing fails the action', stage: 'dispatch', kind: 'playbook_run', policy: 'deny', interactive: 'none', now: MON_1400Z },
  { name: 'outside the hours the action waits', stage: 'dispatch', kind: 'playbook_run', policy: 'allow_office_hours', interactive: 'none', now: MON_1400Z },
  { name: 'the hold is checked before the privileged flag', stage: 'dispatch', kind: 'playbook_run', privileged: true, policy: 'allow_office_no_privileged', interactive: 'none', now: MON_1400Z },
  { name: 'a privileged action under a policy that forbids it fails', stage: 'dispatch', kind: 'playbook_run', privileged: true, policy: 'allow_no_privileged', interactive: 'none', now: MON_1400Z },
  { name: 'a privileged action allowed by the policy runs', stage: 'dispatch', kind: 'playbook_run', privileged: true, policy: 'allow_quiet', interactive: 'none', now: MON_1400Z },
  { name: 'approval only, somebody there: the action card', stage: 'dispatch', kind: 'playbook_run', policy: 'approval_only', interactive: 'active', now: MON_1400Z },
  { name: 'approval only, nobody there: wait for somebody', stage: 'dispatch', kind: 'playbook_run', policy: 'approval_only', interactive: 'locked', now: MON_1400Z },
  { name: 'approval only never counts down', stage: 'dispatch', kind: 'playbook_run', policy: pol({ autoAllowAfterSec: 30 }), interactive: 'active', now: MON_1400Z },
  { name: 'allow, nobody there: runs without a toast', stage: 'dispatch', kind: 'playbook_run', policy: 'allow_quiet', interactive: 'none', now: MON_1400Z },
  { name: 'allow, somebody there, approval not required: runs with the toast', stage: 'dispatch', kind: 'file_push', policy: 'allow_quiet', interactive: 'active', now: MON_1400Z },
  { name: 'allow, somebody there, approval required: the card, no countdown', stage: 'dispatch', kind: 'playbook_run', policy: 'allow_ask', interactive: 'active', now: MON_1400Z },
  { name: 'allow, somebody there, approval required with a countdown', stage: 'dispatch', kind: 'playbook_run', policy: 'allow_ask_countdown', interactive: 'active', now: MON_1400Z },
  { name: 'a print inside the hours runs', stage: 'dispatch', kind: 'print', policy: 'allow_office_hours', interactive: 'locked', now: MON_0430Z },
];

const actions = actionCases.map((c) => {
  const policy = typeof c.policy === 'string' ? policies[c.policy] : c.policy;
  return {
    name: c.name,
    stage: c.stage,
    kind: c.kind,
    privileged: c.privileged ?? false,
    policy: typeof c.policy === 'string' ? c.policy : null,
    policyInline: typeof c.policy === 'string' ? null : c.policy,
    interactive: c.interactive ?? null,
    now: c.now,
    expect: s.decideDeviceAction({
      stage: c.stage,
      kind: c.kind,
      privileged: c.privileged ?? false,
      policy,
      interactive: c.interactive ? { state: c.interactive } : null,
      now: new Date(c.now),
    }),
  };
});

const decisions = { v: 1, policies, merge, windows, sessions, actions };

const files = { 'signatures.json': signatures, 'seal.json': seals, 'decisions.json': decisions };
const check = process.argv.includes('--check');
let bad = 0;
mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const path = join(outDir, name);
  if (check) {
    let cur = '';
    try {
      cur = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (cur !== text) {
      console.error(`stale: ${path}`);
      bad++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
process.exit(bad ? 1 : 0);
