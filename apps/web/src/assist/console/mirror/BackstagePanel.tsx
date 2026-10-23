/**
 * Backstage (Phase B 6, 10.1): open a background tab on the Desk without switching the user's view, then close,
 * keep or bring it to the front (confirmed). Disabled unless the Desk allowed background tabs, the organisation
 * allows them and the level is at least `tab_control`.
 */
import { useState, type FormEvent } from 'react';
import type { ControlOp, TabInfo } from '@indiansassist/shared';
import { Dialog } from '../../../components/Dialog';
import { Button, Input } from '../../../components/ui';
import type { ControlResult } from './controlClient';
import { normaliseNavUrl } from './controlBuilders';
import { tabTitle } from './TabStrip';

type OpFn = (op: ControlOp, args: Record<string, unknown>, okText?: string) => Promise<ControlResult>;

export function backstageBlockedReason(o: { canTab: boolean; consented: boolean; orgAllows: boolean }): string | null {
  if (!o.orgAllows) return "Your organisation's policy does not allow background tabs.";
  if (!o.consented) return 'The user has not allowed background tabs.';
  if (!o.canTab) return 'Needs the "Switch and open tabs" level.';
  return null;
}

export function BackstagePanel({ tabs, canTab, consented, orgAllows, onOp }: { tabs: TabInfo[]; canTab: boolean; consented: boolean; orgAllows: boolean; onOp: OpFn }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [front, setFront] = useState<TabInfo | null>(null);
  const blocked = backstageBlockedReason({ canTab, consented, orgAllows });
  const backstage = tabs.filter((t) => t.backstage);

  const open = (e: FormEvent) => {
    e.preventDefault();
    const u = normaliseNavUrl(url);
    if (!u) return setError('Enter an http or https address.');
    setError(null);
    void onOp('backstage.enter', { url: u }, 'Background tab opened. The user was told.');
  };

  return (
    <section aria-label="Background tabs" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Background tabs</h2>
      {blocked && <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="backstage-blocked">{blocked}</p>}
      <form onSubmit={open} className="flex flex-col gap-1" noValidate>
        <label htmlFor="ia-bs-url" className="text-sm font-medium">
          Address
        </label>
        <Input id="ia-bs-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/settings" disabled={blocked !== null} />
        {error && <p className="text-xs font-medium text-red-700 dark:text-red-400">{error}</p>}
        <Button size="sm" type="submit" disabled={blocked !== null} title={blocked ?? undefined}>
          Open background tab
        </Button>
      </form>
      {backstage.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {backstage.map((t) => (
            <li key={t.tabId} className="flex flex-wrap items-center gap-1">
              <span className="min-w-0 flex-1 truncate">{tabTitle(t)}</span>
              <Button size="sm" variant="ghost" onClick={() => void onOp('backstage.exit', { tabId: t.tabId, action: 'close' }, 'Background tab closed.')}>
                Close
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onOp('backstage.exit', { tabId: t.tabId, action: 'keep' }, 'Kept as an ordinary shared tab.')}>
                Keep
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFront(t)}>
                Bring to front
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-600 dark:text-slate-400">Chrome slows down background tabs, so their mirror may lag.</p>
      <Dialog open={front !== null} title="Bring this tab to the front?" onClose={() => setFront(null)}>
        <p className="mb-4 text-sm">The user&apos;s browser switches to {front ? tabTitle(front) : 'the tab'}.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setFront(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const t = front;
              setFront(null);
              if (t) void onOp('backstage.exit', { tabId: t.tabId, action: 'bring_to_front' }, 'Brought to the front.');
            }}
          >
            Bring to front
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
