/**
 * Tab strip of the P2 console (Phase B 10.1): one chip per mirrored tab with favicon (`data:image/` only, else a
 * letter avatar), title, state badges, the focused tab highlighted and the Desk's active tab dotted; a "User
 * switched to ..." chip with Follow; "+N not shared" for tabs the Desk did not share.
 */
import type { TabInfo } from '@indiansassist/shared';
import { Badge, Button, cx } from '../../../components/ui';
import { tabBadges, type TabsState } from './mirrorState';

function Favicon({ tab }: { tab: TabInfo }) {
  if (tab.favicon && tab.favicon.startsWith('data:image/') && !tab.favicon.startsWith('data:image/svg')) {
    return <img src={tab.favicon} alt="" className="h-4 w-4 shrink-0 rounded-sm" referrerPolicy="no-referrer" />;
  }
  const letter = (tab.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-slate-300 text-[10px] font-bold text-slate-800 dark:bg-slate-600 dark:text-slate-100">
      {letter}
    </span>
  );
}

export function tabTitle(t: TabInfo): string {
  if (t.mirrored === 'denied') return 'Protected tab';
  if (t.mirrored === 'not_in_scope') return 'Tab not shared';
  return t.title || t.url || 'Untitled tab';
}

export function TabStrip({ state, onFocus, onFollow }: { state: TabsState; onFocus: (tabId: number) => void; onFollow: (tabId: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" aria-label="Shared tabs" className="flex flex-wrap items-center gap-1.5">
        {state.tabs.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No shared tabs yet.</p>}
        {state.tabs.map((t) => {
          const focused = t.tabId === state.focusedTabId;
          const badges = tabBadges(t, state.views[t.tabId]);
          return (
            <button
              key={t.tabId}
              type="button"
              role="tab"
              aria-selected={focused}
              data-testid={`tab-${t.tabId}`}
              onClick={() => onFocus(t.tabId)}
              title={t.url ?? undefined}
              className={cx(
                'flex max-w-64 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-sm',
                focused ? 'border-teal-700 bg-teal-50 font-semibold dark:border-teal-400 dark:bg-teal-950' : 'border-slate-300 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
              )}
            >
              {t.tabId === state.activeTabId && <span aria-label="active on the Desk" className="h-2 w-2 shrink-0 rounded-full bg-green-600" />}
              <Favicon tab={t} />
              <span className="truncate">{tabTitle(t)}</span>
              {badges.map((b) => (
                <Badge key={b} tone={b === 'protected' || b === 'revealed' ? 'red' : b === 'paused' || b === 'too large' ? 'amber' : 'neutral'}>
                  {b}
                </Badge>
              ))}
            </button>
          );
        })}
        {state.hiddenCount > 0 && <Badge>+{state.hiddenCount} not shared</Badge>}
      </div>
      {state.switchedTo && (
        <div role="status" className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1 text-sm dark:bg-amber-950">
          <span>User switched to {state.switchedTo.title}</span>
          <Button size="sm" variant="secondary" onClick={() => onFollow(state.switchedTo!.tabId)}>
            Follow
          </Button>
        </div>
      )}
    </div>
  );
}
