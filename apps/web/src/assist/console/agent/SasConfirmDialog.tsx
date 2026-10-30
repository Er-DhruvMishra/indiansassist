/**
 * Section 1.3 step 7 / 13.4 `SasConfirmDialog`: the technician types the six digits the user reads out from the Desk
 * pill; three attempts, then the step re-arms after 10 s. **Skip** only when the org does not require the
 * confirmation (chained as skipped). The modal returns after every rebuild (new key generation).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '../../../components/Dialog';
import { Alert, Button, Field, Input } from '../../../components/ui';
import type { SasCheck } from './sasGate';

export const SAS_STOP_TEXT = 'If the two codes differ, stop the session.';

export function SasConfirmDialog({
  open,
  gen,
  requireConfirm,
  onConfirm,
  onSkip,
  onClose,
  now = Date.now,
}: {
  open: boolean;
  gen: number;
  requireConfirm: boolean;
  onConfirm: (typed: string) => SasCheck;
  onSkip: () => void;
  onClose: () => void;
  now?: () => number;
}) {
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    setTyped('');
    setMsg(null);
  }, [gen, open]);

  useEffect(() => {
    if (lockedUntil <= now()) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(50, lockedUntil - now()));
    return () => clearTimeout(t);
  }, [lockedUntil, now]);

  const locked = lockedUntil > now();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = onConfirm(typed);
    setTyped('');
    if (r.result === 'ok') return setMsg(null);
    if (r.result === 'locked') {
      setLockedUntil(r.state.lockedUntil);
      return setMsg('Too many wrong codes. Wait 10 seconds and ask the user to read the code again.');
    }
    setMsg(`That code does not match. ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? '' : 's'} left.`);
  };

  return (
    <Dialog open={open} title="Confirm the security code" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm">
          Ask the user to read the 6-digit security code shown next to the timer on their IndiansAssist bar, then type it here.
          {gen > 0 && ' The secure connection was rebuilt, so the code is new.'}
        </p>
        <Alert tone="amber">{SAS_STOP_TEXT}</Alert>
        <Field label="Security code the user reads out" error={msg}>
          {(p) => (
            <Input
              id={p.id}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid}
              inputMode="numeric"
              autoComplete="off"
              data-autofocus
              maxLength={7}
              value={typed}
              disabled={locked}
              onChange={(e) => setTyped(e.target.value.replace(/[^\d ]/g, ''))}
            />
          )}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          {!requireConfirm && (
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button type="submit" disabled={locked || typed.replace(/\s/g, '').length !== 6}>
            Confirm code
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
