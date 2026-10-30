/**
 * Section 13.4 `InputModeToggle`: **View** / **Control** / **Elevated**. It branches on `consentLevelFamily(tier)`
 * before any compare (section 3.4, `levelAllows`). Control is greyed until the user granted `control` (with
 * **Ask the user** -> `level.request`) and the security code of the current generation is confirmed; **Elevated**
 * opens the elevation dialog. The chip reads the level back from `consent.changed` / `agent_level`.
 */
import { useState } from 'react';
import type { PackageTier } from '@indiansassist/shared';
import { Dialog } from '../../../components/Dialog';
import { Badge, Button, Field, Input } from '../../../components/ui';
import { levelAllows } from './agentState';

export function InputModeToggle({
  tier,
  level,
  chip,
  mode,
  secured,
  sasConfirmed,
  canElevate,
  onMode,
  onAskControl,
  onElevate,
  onConfirmSas,
}: {
  tier: PackageTier;
  level: string | null;
  chip: string;
  mode: 'view' | 'control';
  secured: boolean;
  sasConfirmed: boolean;
  canElevate: boolean;
  onMode: (m: 'view' | 'control') => void;
  onAskControl: (reason: string) => void;
  onElevate: () => void;
  onConfirmSas: () => void;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const [reason, setReason] = useState('');
  const levelOk = levelAllows(tier, level, 'control');
  const controlReady = secured && levelOk && sasConfirmed;
  const elevated = levelAllows(tier, level, 'elevated');
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Input mode">
      <Button size="sm" variant={mode === 'view' ? 'primary' : 'secondary'} aria-pressed={mode === 'view'} onClick={() => onMode('view')}>
        View
      </Button>
      <Button size="sm" variant={mode === 'control' ? 'primary' : 'secondary'} aria-pressed={mode === 'control'} disabled={!controlReady} onClick={() => onMode('control')}>
        Control
      </Button>
      <Button size="sm" variant="secondary" disabled={!secured || !canElevate || elevated} onClick={onElevate}>
        Elevated
      </Button>
      <Badge tone={elevated ? 'red' : levelOk ? 'green' : 'neutral'}>{chip}</Badge>
      {secured && !levelOk && (
        <Button size="sm" variant="ghost" onClick={() => setAskOpen(true)}>
          Ask the user
        </Button>
      )}
      {secured && levelOk && !sasConfirmed && (
        <Button size="sm" variant="ghost" onClick={onConfirmSas}>
          Confirm security code
        </Button>
      )}
      {!secured && <span className="text-xs text-slate-600 dark:text-slate-400">Securing the connection</span>}
      <Dialog open={askOpen} title="Ask to control the mouse and keyboard" onClose={() => setAskOpen(false)}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onAskControl(reason.trim());
            setAskOpen(false);
            setReason('');
          }}
        >
          <Field label="Reason shown to the user" hint="The user sees your name and this reason and chooses Allow or Refuse.">
            {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-autofocus />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAskOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={reason.trim().length === 0}>
              Ask the user
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
