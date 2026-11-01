/**
 * `UnattendedPolicyEditor` (docs/specs/phase-d-contracts.md sections 6.1, 13.4): every section 6.1 field with the safe
 * defaults of `DEFAULT_UNATTENDED_POLICY`, an allowed-hours builder, and clear warnings on dangerous combinations.
 * In `override` mode (a group default or a device override) the fields show what they inherit and the save sends only
 * the keys set here, read from the stored override (`override`) when the caller has it, so an override stays a
 * difference and never a frozen copy. Saving is audited by the server
 * (`org.policy_updated`, `device_group.updated`, `device.updated`).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { DEFAULT_UNATTENDED_POLICY, UNATTENDED_MODES, type AllowedHours, type UnattendedMode, type UnattendedPolicy, type UnattendedPolicyPatch } from '@indiansassist/shared';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { dayName, UNATTENDED_MODE_TEXT } from './fleetText';
import {
  POLICY_FIELD_LABELS,
  POLICY_KEYS,
  overrideKeys,
  overriddenKeys,
  patchFromKeys,
  policyProblems,
  policyWarnings,
  type PolicyKey,
} from './policyRules';

const BOOL_FIELDS = [
  'recordingRequired',
  'allowLogonScreen',
  'allowSecureDesktop',
  'allowPrivileged',
  'allowInputLock',
  'allowPrivacyScreen',
  'allowAmtSol',
  'allowAmtBootRedirect',
  'notifyLocalUser',
] as const satisfies readonly PolicyKey[];

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export type PolicyEditorProps = {
  /** The policy as it stands (a full policy; for an override mode, the merged effective policy). */
  value: UnattendedPolicy;
  /** `full` edits the org default; `override` edits a group default or a device override against `inherited`. */
  mode: 'full' | 'override';
  /** What the override inherits when a key is not set (the org default, or org + group for a device). */
  inherited?: UnattendedPolicy;
  /**
   * The override as stored on this object (`device.unattended_policy`, `device_group.default_policy`). Given, it is
   * the authority on which keys are set here; omitted, the editor falls back to diffing `value` against `inherited`.
   */
  override?: UnattendedPolicyPatch | null;
  inheritedLabel?: string;
  title: string;
  busy?: boolean;
  onSaveFull?: (policy: UnattendedPolicy) => void;
  onSavePatch?: (patch: UnattendedPolicyPatch) => void;
  onCancel?: () => void;
};

export function UnattendedPolicyEditor({
  value,
  mode,
  inherited,
  override,
  inheritedLabel = 'the organisation default',
  title,
  busy,
  onSaveFull,
  onSavePatch,
  onCancel,
}: PolicyEditorProps) {
  const base = inherited ?? DEFAULT_UNATTENDED_POLICY;
  const [p, setP] = useState<UnattendedPolicy>(value);
  // The keys set on this object: from the stored override when the caller has it, else diffed from what it inherits.
  const stored = useMemo(() => (override === undefined ? overriddenKeys(base, value) : overrideKeys(override)), [override, base, value]);
  const [setHere, setSetHere] = useState<readonly PolicyKey[]>(stored);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => setP(value), [value]);
  useEffect(() => setSetHere(stored), [stored]);
  const set = <K extends PolicyKey>(k: K, v: UnattendedPolicy[K]) => {
    setP((o) => ({ ...o, [k]: v }));
    setSetHere((o) => (o.includes(k) ? o : POLICY_KEYS.filter((x) => x === k || o.includes(x))));
  };
  const problems = useMemo(() => policyProblems(p), [p]);
  const warnings = useMemo(() => policyWarnings(p), [p]);
  const overridden = useMemo(() => (mode === 'override' ? setHere : []), [mode, setHere]);
  const headingId = useId();

  const inheritNote = (k: PolicyKey) =>
    mode === 'override' && !overridden.includes(k) ? `Inherited from ${inheritedLabel}` : mode === 'override' ? 'Set here' : undefined;

  const save = () => {
    setAttempted(true);
    if (problems.length > 0) return;
    if (mode === 'full') onSaveFull?.(p);
    else onSavePatch?.(patchFromKeys(p, setHere));
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="text-base font-semibold">
        {title}
      </h3>
      {mode === 'override' && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Fields you do not change stay inherited from {inheritedLabel}. {overridden.length === 0 ? 'Nothing is overridden here yet.' : `${overridden.length} field${overridden.length === 1 ? '' : 's'} overridden: ${overridden.map((k) => POLICY_FIELD_LABELS[k]).join(', ')}.`}
        </p>
      )}

      {attempted && problems.length > 0 && (
        <Alert>
          <p className="font-semibold">This policy cannot be saved yet:</p>
          <ul className="list-disc pl-5">
            {problems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      {warnings.length > 0 && (
        <div aria-live="polite">
          <Alert tone="amber">
            <p className="font-semibold">What this policy allows</p>
            <ul className="list-disc pl-5">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={POLICY_FIELD_LABELS.mode} hint={inheritNote('mode')}>
          {(f) => (
            <Select id={f.id} aria-describedby={f.describedBy} value={p.mode} onChange={(e) => set('mode', e.target.value as UnattendedMode)}>
              {UNATTENDED_MODES.map((m) => (
                <option key={m} value={m}>
                  {UNATTENDED_MODE_TEXT[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={POLICY_FIELD_LABELS.maxUnattendedMinutes}
          hint={inheritNote('maxUnattendedMinutes') ?? '0 = no limit'}
        >
          {(f) => (
            <Input
              id={f.id}
              aria-describedby={f.describedBy}
              type="number"
              min={0}
              max={1440}
              value={String(p.maxUnattendedMinutes)}
              onChange={(e) => set('maxUnattendedMinutes', Number(e.target.value))}
            />
          )}
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-label={POLICY_FIELD_LABELS.requireLocalApprovalWhenPresent}
          checked={p.requireLocalApprovalWhenPresent}
          onChange={(e) => set('requireLocalApprovalWhenPresent', e.target.checked)}
        />
        <span>
          {POLICY_FIELD_LABELS.requireLocalApprovalWhenPresent}
          <span className="block text-xs text-slate-600 dark:text-slate-400">
            Do not take over a machine someone is using without a nod. {inheritNote('requireLocalApprovalWhenPresent') ?? ''}
          </span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={POLICY_FIELD_LABELS.autoAllowAfterSec} hint={inheritNote('autoAllowAfterSec') ?? '10 to 120 seconds, or off'}>
          {(f) => (
            <div className="flex items-center gap-2">
              <Select
                id={f.id}
                aria-describedby={f.describedBy}
                value={p.autoAllowAfterSec === null ? 'off' : 'on'}
                onChange={(e) => set('autoAllowAfterSec', e.target.value === 'off' ? null : 30)}
                className="w-32"
              >
                <option value="off">Off</option>
                <option value="on">After</option>
              </Select>
              {p.autoAllowAfterSec !== null && (
                <Input
                  aria-label="Auto-allow seconds"
                  type="number"
                  min={10}
                  max={120}
                  className="w-24"
                  value={String(p.autoAllowAfterSec)}
                  onChange={(e) => set('autoAllowAfterSec', Number(e.target.value))}
                />
              )}
            </div>
          )}
        </Field>
      </div>

      <AllowedHoursBuilder value={p.allowedHours} note={inheritNote('allowedHours')} onChange={(h) => set('allowedHours', h)} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">What a technician may do</legend>
        {BOOL_FIELDS.map((k) => (
          <label key={k} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" aria-label={POLICY_FIELD_LABELS[k]} checked={p[k]} onChange={(e) => set(k, e.target.checked)} />
            <span>
              {POLICY_FIELD_LABELS[k]}
              {mode === 'override' && <span className="block text-xs text-slate-600 dark:text-slate-400">{inheritNote(k)}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy}>
          Save policy
        </Button>
        {mode === 'override' && overridden.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => {
              setP(base);
              setSetHere([]);
            }}
            disabled={busy}
          >
            Clear all overrides
          </Button>
        )}
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}

function AllowedHoursBuilder({ value, note, onChange }: { value: AllowedHours | null; note?: string; onChange: (h: AllowedHours | null) => void }) {
  const tzId = useId();
  const on = value !== null;
  const h = value ?? { tz: localZone(), windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] };
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
      <legend className="px-1 text-sm font-medium">{POLICY_FIELD_LABELS.allowedHours}</legend>
      {note && <p className="text-xs text-slate-600 dark:text-slate-400">{note}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? h : null)} />
        Limit unattended sessions and device actions to set hours
      </label>
      {!on && <p className="text-xs text-slate-600 dark:text-slate-400">Any time. Attended requests always ignore allowed hours.</p>}
      {on && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={tzId} className="text-xs font-medium">
              Time zone
            </label>
            <Input id={tzId} className="sm:w-64" value={h.tz} onChange={(e) => onChange({ ...h, tz: e.target.value })} />
          </div>
          <ul className="flex flex-col gap-2">
            {h.windows.map((w, i) => (
              <li key={i} className="flex flex-wrap items-end gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
                <fieldset className="flex flex-wrap items-center gap-2">
                  <legend className="sr-only">{`Window ${i + 1} days`}</legend>
                  {WEEKDAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={w.days.includes(d)}
                        aria-label={`Window ${i + 1} ${dayName(d)}`}
                        onChange={(e) => {
                          const days = e.target.checked ? [...w.days, d].sort((a, b) => a - b) : w.days.filter((x) => x !== d);
                          onChange({ ...h, windows: h.windows.map((x, j) => (j === i ? { ...x, days } : x)) });
                        }}
                      />
                      {dayName(d)}
                    </label>
                  ))}
                </fieldset>
                <label className="flex flex-col text-xs">
                  <span>{`Window ${i + 1} from`}</span>
                  <Input
                    type="time"
                    className="w-32"
                    aria-label={`Window ${i + 1} from`}
                    value={w.from}
                    onChange={(e) => onChange({ ...h, windows: h.windows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })}
                  />
                </label>
                <label className="flex flex-col text-xs">
                  <span>{`Window ${i + 1} to`}</span>
                  <Input
                    type="time"
                    className="w-32"
                    aria-label={`Window ${i + 1} to`}
                    value={w.to}
                    onChange={(e) => onChange({ ...h, windows: h.windows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })}
                  />
                </label>
                {h.windows.length > 1 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onChange({ ...h, windows: h.windows.filter((_, j) => j !== i) })}
                  >
                    {`Remove window ${i + 1}`}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={h.windows.length >= 14}
              onClick={() => onChange({ ...h, windows: [...h.windows, { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] })}
            >
              Add a window
            </Button>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">An overnight window is written as two windows.</p>
        </>
      )}
    </fieldset>
  );
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}
