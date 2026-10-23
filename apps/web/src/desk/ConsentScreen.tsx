/**
 * Consent screen (contracts section 12.1 D1 / D2): who is asking (the accepting technician from
 * `session.created`), org, what will and cannot be shared, the pre-share checklist with blur-on-share
 * guidance, the single-window toggle, Share my screen and Decline.
 */
import { useState } from 'react';
import { Alert, Button } from '../components/ui';
import { safeAccent } from '../lib/contrast';
import type { DeskController, DeskSnapshot } from './deskController';
import { DeskLayout } from './DeskLayout';

export function ConsentScreen({ ctrl, snap }: { ctrl: DeskController; snap: DeskSnapshot }) {
  const [ready, setReady] = useState(false);
  const [singleWindow, setSingleWindow] = useState(true);
  const created = snap.created;
  if (!created) return null;
  const org = created.org;
  const busy = snap.phase !== 'consent';
  return (
    <DeskLayout>
      <div className="rounded-lg border-t-4 bg-white p-5 shadow-sm dark:bg-slate-900" style={{ borderTopColor: safeAccent(org.accentColor) }}>
        <div className="mb-4 flex items-center gap-3">
          {org.logoData?.startsWith('data:image/') && <img src={org.logoData} alt="" className="h-10 w-10 rounded object-contain" />}
          <h1 className="text-xl font-semibold">
            {created.assist.name} from {org.displayName} is asking to see your screen
          </h1>
        </div>
        <section aria-labelledby="what-shared" className="mb-4 text-sm">
          <h2 id="what-shared" className="mb-1 font-semibold">What will be shared</h2>
          <p>Your screen, a window or a tab: you choose in the next step. You can stop at any time.</p>
          <h2 className="mb-1 mt-3 font-semibold">What cannot happen</h2>
          <p>The technician cannot control your mouse or keyboard. They can chat, talk if you turn on voice, send files you approve, and draw pointers on a preview only you see.</p>
        </section>
        <section aria-labelledby="checklist" className="mb-4 rounded-md bg-slate-100 p-3 text-sm dark:bg-slate-800">
          <h2 id="checklist" className="mb-2 font-semibold">Before you share</h2>
          <ul className="mb-3 list-inside list-disc space-y-1">
            <li>Close or mute notifications: turn on Focus Assist / Do Not Disturb on Windows, or Do Not Disturb on macOS.</li>
            <li>Close or hide sensitive windows, documents, chats and password managers.</li>
            <li>Prefer sharing a single window rather than your whole screen.</li>
          </ul>
          <p className="mb-3 text-xs text-slate-700 dark:text-slate-300">
            A web page cannot blur or hide your taskbar or notifications by itself, so these steps are up to you.
          </p>
          <label className="mb-2 flex items-start gap-2">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={singleWindow} onChange={(e) => setSingleWindow(e.target.checked)} />
            <span>Share a single window instead of my whole screen</span>
          </label>
          <label className="flex items-start gap-2 font-medium">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={ready} onChange={(e) => setReady(e.target.checked)} aria-required="true" />
            <span>I have closed or hidden anything private</span>
          </label>
        </section>
        {snap.notice && <div className="mb-3"><Alert tone="amber">{snap.notice}</Alert></div>}
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Button size="lg" disabled={!ready || busy} onClick={() => void ctrl.share(singleWindow)}>
            {snap.phase === 'picking' ? 'Choose what to share...' : snap.phase === 'starting' ? 'Starting...' : 'Share my screen'}
          </Button>
          <Button size="lg" variant="secondary" disabled={snap.phase === 'starting'} onClick={() => ctrl.decline()}>
            Decline
          </Button>
        </div>
        {!ready && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Tick the checklist box to enable sharing.</p>}
      </div>
    </DeskLayout>
  );
}
