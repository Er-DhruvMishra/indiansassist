/**
 * Reason dialog (Phase B 10.4): the technician's reason for a level, attach or reveal request, 1..500 characters,
 * written to the audit trail with the request and with the Desk's answer.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { LIMITS } from '@indiansassist/shared';
import { Dialog } from './Dialog';
import { Button, Field } from './ui';

export function ReasonDialog({
  open,
  title,
  description,
  submitLabel = 'Send request',
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel?: string;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < 1) return setError('Enter a reason.');
    if (r.length > LIMITS.reasonMax) return setError(`At most ${LIMITS.reasonMax} characters.`);
    onSubmit(r);
  };
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <p className="text-sm">{description}</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">The user decides; your reason is written to the audit trail.</p>
        <Field label="Reason" error={error} hint={`${reason.trim().length} / ${LIMITS.reasonMax}`}>
          {(p) => (
            <textarea
              id={p.id}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid}
              value={reason}
              maxLength={LIMITS.reasonMax}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
