/** Section 13.4 `NavButtons` (Android Desks only) and `ClipboardToggle` (the console's half of clipboard sync). */
import { NAV_ACTIONS, type NavAction } from '@indiansassist/shared';
import { Button } from '../../../components/ui';
import { CopyButton } from '../../../components/CopyButton';

const NAV_LABEL: Record<NavAction, string> = { back: 'Back', home: 'Home', recents: 'Recents', notifications: 'Notifications' };

export function NavButtons({ show, disabled, onNav }: { show: boolean; disabled: boolean; onNav: (a: NavAction) => void }) {
  if (!show) return null;
  return (
    <div role="group" aria-label="Phone navigation" className="flex flex-wrap gap-1">
      {NAV_ACTIONS.map((a) => (
        <Button key={a} size="sm" variant="secondary" disabled={disabled} onClick={() => onNav(a)}>
          {NAV_LABEL[a]}
        </Button>
      ))}
    </div>
  );
}

export function ClipboardToggle({
  on,
  allowed,
  received,
  onToggle,
}: {
  on: boolean;
  /** The Desk switch is on (`consent.changed.clipboard`) and the `clipboard` feature is present. */
  allowed: boolean;
  received: string | null;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on && allowed} disabled={!allowed} onChange={(e) => onToggle(e.target.checked)} />
        Clipboard sync
      </label>
      {!allowed && <p className="text-xs text-slate-600 dark:text-slate-400">The user has not turned on clipboard sharing.</p>}
      {received !== null && <CopyButton size="sm" variant="secondary" text={received} label="Clipboard received, click to copy" />}
    </div>
  );
}
