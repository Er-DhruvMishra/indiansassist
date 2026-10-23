/**
 * Create token (contracts sections 3.2, 6.7, 12): tier (enum driven, capped by the caller's seat tier;
 * p1_browser and, from Phase B, p2_extension join), type, lifetime, label. On success shows the join link, a client-side QR, the
 * short code with the host it is valid on, and copy buttons.
 */
import { useState, type FormEvent } from 'react';
import {
  PACKAGE_TIERS,
  TOKEN_LIFETIMES,
  tierWithin,
  type CreateTokenResponse,
  type PackageTier,
  type TokenType,
} from '@indiansassist/shared';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { QrCode } from '../../components/QrCode';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { tokensApi } from '../../lib/endpoints';
import { fmtDateTime, fmtTier } from '../../lib/format';

type AttendedType = Exclude<TokenType, 'enrollment'>;

/** What the Desk needs for each tier (Phase B 2: P2 joins through the browser extension). */
export const TIER_HINT: Record<PackageTier, string> = {
  p1_browser: 'The Desk shares a screen or window from the browser. Nothing to install.',
  p2_extension: 'The Desk shares browser tabs through the IndiansAssist extension (Chrome or Edge). The join page helps them install or open it.',
  p3_portable: 'Not available yet: the Desk sees a notice instead of joining.',
  p4_installed: 'Not available yet: the Desk sees a notice instead of joining.',
};

export function CreateTokenForm({
  seatTier,
  onCreated,
}: {
  seatTier: PackageTier | null;
  onCreated: (r: CreateTokenResponse) => void;
}) {
  const [tier, setTier] = useState<PackageTier>('p1_browser');
  const [typ, setTyp] = useState<TokenType>('one_time');
  const [minutes, setMinutes] = useState<string>(String(TOKEN_LIFETIMES.one_time.defaultMin));
  const [days, setDays] = useState<string>(String(TOKEN_LIFETIMES.enrollment.defaultDays));
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cap: PackageTier = seatTier ?? 'p1_browser';
  const enrollment = typ === 'enrollment';
  const maxMin = enrollment ? 0 : TOKEN_LIFETIMES[typ as AttendedType].maxMin;
  const lifetimeError = (() => {
    if (enrollment) {
      const d = Number(days);
      return Number.isInteger(d) && d >= 1 && d <= TOKEN_LIFETIMES.enrollment.maxDays
        ? null
        : `Enter 1 to ${TOKEN_LIFETIMES.enrollment.maxDays} days.`;
    }
    const m = Number(minutes);
    return Number.isInteger(m) && m >= 1 && m <= maxMin ? null : `Enter 1 to ${maxMin} minutes.`;
  })();

  const onType = (t: TokenType) => {
    setTyp(t);
    if (t !== 'enrollment') setMinutes(String(TOKEN_LIFETIMES[t].defaultMin));
  };

  const onTier = (t: PackageTier) => {
    setTier(t);
    if (t !== 'p4_installed' && typ === 'enrollment') onType('one_time');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (lifetimeError) return;
    setBusy(true);
    setError(null);
    try {
      const body = enrollment
        ? { tier, typ, ttlDays: Number(days) }
        : { tier, typ, ttlMinutes: Number(minutes) };
      const trimmed = label.trim();
      onCreated(await tokensApi.create(trimmed ? { ...body, label: trimmed } : body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field label="Package tier" hint={TIER_HINT[tier]}>
        {(p) => (
          <Select id={p.id} aria-describedby={p.describedBy} value={tier} onChange={(e) => onTier(e.target.value as PackageTier)}>
            {PACKAGE_TIERS.map((t) => (
              <option key={t} value={t} disabled={!tierWithin(t, cap)}>
                {fmtTier(t)}
                {tierWithin(t, cap) ? '' : ' (not licensed for your seat)'}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Token type</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="typ" value="one_time" checked={typ === 'one_time'} onChange={() => onType('one_time')} />
          One time (one session, default {TOKEN_LIFETIMES.one_time.defaultMin} min)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="typ" value="timed" checked={typ === 'timed'} onChange={() => onType('timed')} />
          Timed (sequential sessions until expiry, up to {TOKEN_LIFETIMES.timed.maxMin} min)
        </label>
        {tier === 'p4_installed' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="typ" value="enrollment" checked={enrollment} onChange={() => onType('enrollment')} />
            Enrollment (reserved for Package 4)
          </label>
        )}
      </fieldset>
      {enrollment ? (
        <Field label="Lifetime (days)" error={lifetimeError}>
          {(p) => (
            <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} type="number" min={1} max={TOKEN_LIFETIMES.enrollment.maxDays} value={days} onChange={(e) => setDays(e.target.value)} />
          )}
        </Field>
      ) : (
        <Field label="Lifetime (minutes)" hint={`Maximum ${maxMin} minutes.`} error={lifetimeError}>
          {(p) => (
            <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} type="number" min={1} max={maxMin} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          )}
        </Field>
      )}
      <Field label="Label (optional)" hint="Shown to you and in the knock request, e.g. a ticket number.">
        {(p) => <Input id={p.id} aria-describedby={p.describedBy} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />}
      </Field>
      <Button type="submit" disabled={busy || lifetimeError !== null}>
        {busy ? 'Creating...' : 'Create token'}
      </Button>
    </form>
  );
}

export function TokenCreatedPanel({ result }: { result: CreateTokenResponse }) {
  const t = result.token;
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <Alert tone="green">Token created. It expires {fmtDateTime(t.expiresAt)}.</Alert>
      {t.tier === 'p2_extension' && (
        <p className="text-sm" data-testid="p2-note">
          Browser extension session: the Desk opens the link in Chrome or Edge, installs or opens the IndiansAssist extension, then chooses which tabs to share.
        </p>
      )}
      <div className="flex flex-col gap-4 sm:flex-row">
        <QrCode text={result.joinUrl} label="QR code of the join link" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Short code</p>
            <p className="font-mono text-2xl font-semibold tracking-wider" data-testid="short-code">
              {t.shortCodeDisplay}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">Valid on {t.joinHost}</p>
          </div>
          <div>
            <label htmlFor="join-link" className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">
              Join link
            </label>
            <input id="join-link" readOnly value={result.joinUrl} onFocus={(e) => e.currentTarget.select()} className="mt-1 w-full truncate rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={result.joinUrl} label="Copy link" />
        <CopyButton text={t.shortCode} label="Copy short code" variant="secondary" />
        <CopyButton text={result.compact} label="Copy token" variant="secondary" />
      </div>
    </div>
  );
}

export function CreateTokenDialog({
  open,
  onClose,
  seatTier,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  seatTier: PackageTier | null;
  onCreated?: (r: CreateTokenResponse) => void;
}) {
  const [result, setResult] = useState<CreateTokenResponse | null>(null);
  const close = () => {
    setResult(null);
    onClose();
  };
  return (
    <Dialog open={open} title={result ? 'Share this token with the Desk' : 'Create a support token'} onClose={close} wide={result !== null}>
      {result ? (
        <div className="flex flex-col gap-4">
          <TokenCreatedPanel result={result} />
          <Button variant="secondary" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <CreateTokenForm
          seatTier={seatTier}
          onCreated={(r) => {
            setResult(r);
            onCreated?.(r);
          }}
        />
      )}
    </Dialog>
  );
}
