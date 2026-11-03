/**
 * Phase F section 7.4: the phone and tablet layouts of a live console (the desktop layout, 1024 px and wider, is each
 * console's own, unchanged).
 * - phone portrait (< 600 px): the Desk view full width at the top, a one-line header with the security-code state
 *   and End, and a bottom tab bar (View, Chat, Files, Keys, More) switching a sheet below the view;
 * - phone landscape (or the installed app in landscape): the view fills the screen; a floating toolbar hides after
 *   3 s without touch and returns on a tap at the top edge; a tab opens its sheet beside the view;
 * - tablet (600-1023 px): the view with a collapsible side panel.
 * Every section stays mounted (hidden when not shown), so nothing a section holds (a chat draft, a camera, a
 * transfer) is lost when the technician switches tabs; the three mobile layouts share one element tree, so rotating
 * the phone does not remount the view. Nothing is hidden on phones except behind a tab.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import type { ConsoleLayoutKind } from './useViewport';

export type ConsoleTab = 'view' | 'chat' | 'files' | 'keys' | 'more';
export type ConsoleSection = { id: ConsoleTab; label: string; content: ReactNode };

const HIDE_AFTER_MS = 3000;

export function MobileConsoleLayout({
  layout,
  title,
  badges,
  endLabel = 'End',
  onEnd,
  status,
  view,
  sections,
  active,
  onActive,
}: {
  layout: Exclude<ConsoleLayoutKind, 'desktop'>;
  title: string;
  /** The one-line header's state (security code, phase). */
  badges: ReactNode;
  endLabel?: string;
  onEnd: () => void;
  status: ReactNode;
  view: ReactNode;
  sections: ConsoleSection[];
  active: ConsoleTab;
  onActive: (tab: ConsoleTab) => void;
}) {
  const id = useId();
  const landscape = layout === 'phone_landscape';
  const tablet = layout === 'tablet';
  const phone = layout === 'phone';
  const [panelOpen, setPanelOpen] = useState(true);
  const [toolbar, setToolbar] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Landscape: the sheet is open only after a tab was chosen there; the toolbar hides after 3 s without touch.
  const [sheetOpen, setSheetOpen] = useState(false);
  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    if (!landscape) return;
    hideTimer.current = setTimeout(() => setToolbar(false), HIDE_AFTER_MS);
  }, [landscape]);
  useEffect(() => {
    setToolbar(true);
    armHide();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [armHide]);
  const showToolbar = () => {
    setToolbar(true);
    armHide();
  };

  const choose = (tab: ConsoleTab) => {
    if (landscape) {
      setSheetOpen(!(sheetOpen && active === tab));
      showToolbar();
    }
    if (tablet) setPanelOpen(!(panelOpen && active === tab));
    onActive(tab);
  };
  const shown = landscape ? sheetOpen : tablet ? panelOpen : true;
  const toolbarVisible = !landscape || toolbar || sheetOpen;

  return (
    <div
      data-layout={layout}
      onPointerDownCapture={landscape ? showToolbar : undefined}
      className={cx(
        landscape && 'fixed inset-0 z-40 overflow-hidden bg-slate-950 text-slate-100',
        phone && 'flex flex-col gap-2 pb-[calc(4.5rem+env(safe-area-inset-bottom))]',
        tablet && cx('grid gap-3', shown ? 'grid-cols-[minmax(0,1fr)_20rem]' : 'grid-cols-1'),
      )}
    >
      <div
        className={cx(
          landscape && 'absolute inset-x-0 top-0 z-30 bg-slate-900/90 px-[max(0.5rem,env(safe-area-inset-left))] pb-1 pt-[max(0.25rem,env(safe-area-inset-top))] transition-opacity',
          landscape && !toolbarVisible && 'pointer-events-none opacity-0',
          tablet && 'col-span-full flex flex-wrap items-center gap-2',
        )}
        aria-hidden={landscape && !toolbarVisible ? true : undefined}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h1 className={cx('min-w-0 flex-1 truncate font-semibold', tablet ? 'text-xl' : 'text-base')}>{title}</h1>
          <div className="flex shrink-0 items-center gap-1 text-sm">{badges}</div>
          <button
            type="button"
            onClick={onEnd}
            className="min-h-11 min-w-11 shrink-0 rounded-md bg-red-700 px-3 text-sm font-medium text-white hover:bg-red-800"
          >
            {endLabel}
          </button>
        </div>
        <div
          role="tablist"
          aria-label="Console panels"
          className={cx(
            'flex gap-1',
            phone &&
              'fixed inset-x-0 bottom-0 z-30 justify-around border-t border-slate-300 bg-white px-1 pb-[env(safe-area-inset-bottom)] pt-1 dark:border-slate-700 dark:bg-slate-900',
            landscape && 'mt-1 flex-wrap',
            tablet && 'ml-auto flex-wrap',
          )}
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`${id}-tab-${s.id}`}
              aria-selected={active === s.id && shown}
              aria-controls={`${id}-panel-${s.id}`}
              onClick={() => choose(s.id)}
              className={cx(
                'min-h-11 min-w-11 rounded-md px-3 text-sm font-medium',
                active === s.id && shown ? 'bg-teal-700 text-white' : landscape ? 'bg-slate-800 text-slate-100' : 'text-slate-800 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800',
                phone && 'flex-1',
              )}
            >
              {s.label}
            </button>
          ))}
          {tablet && (
            <button
              type="button"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((o) => !o)}
              className="min-h-11 min-w-11 rounded-md border border-slate-400 px-3 text-sm font-medium dark:border-slate-500"
            >
              {panelOpen ? 'Hide panel' : 'Show panel'}
            </button>
          )}
        </div>
      </div>
      <div className={cx(landscape && 'absolute inset-x-2 bottom-2 z-20 max-h-24 overflow-auto rounded bg-slate-900/80 p-1 text-sm', tablet && 'col-span-full')}>{status}</div>
      <div
        className={cx(
          landscape && 'absolute inset-0 flex items-center justify-center pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
          tablet && 'col-start-1 min-w-0',
          phone && '-mx-2',
        )}
        data-testid="console-view"
      >
        {view}
      </div>
      <div
        className={cx(
          landscape &&
            (sheetOpen
              ? 'absolute bottom-0 right-0 top-0 z-40 w-[min(28rem,55%)] overflow-auto bg-white p-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-slate-900 dark:bg-slate-900 dark:text-slate-100'
              : 'hidden'),
          tablet && (panelOpen ? 'col-start-2 row-start-3 min-w-0' : 'hidden'),
        )}
      >
        {landscape && sheetOpen && (
          <button type="button" className="mb-2 min-h-11 min-w-11 rounded-md border border-slate-400 px-3 text-sm font-medium" onClick={() => setSheetOpen(false)}>
            Close panel
          </button>
        )}
        {sections.map((s) => (
          <section
            key={s.id}
            role="tabpanel"
            id={`${id}-panel-${s.id}`}
            aria-labelledby={`${id}-tab-${s.id}`}
            hidden={active !== s.id}
            className="flex flex-col gap-3"
          >
            {s.content}
          </section>
        ))}
      </div>
      {landscape && !toolbarVisible && (
        <button type="button" aria-label="Show the toolbar" className="absolute inset-x-0 top-0 z-30 h-10 w-full bg-transparent" onClick={showToolbar} />
      )}
    </div>
  );
}
