/**
 * Desk sharing room (contracts section 12.1 D3-D8): the always visible top banner (first in the tab
 * order) with the technician and org, recording dot, timer, preview button, Stop sharing and Revoke
 * consent; chat, voice (opt-in, default off) and files below; favicon switches while sharing.
 */
import { useEffect, useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { FilePanel } from '../components/FilePanel';
import { DESK_SHORTCUTS, ShortcutHelp, shouldIgnoreKey } from '../components/ShortcutHelp';
import { Alert, Button, Card } from '../components/ui';
import { RemoteAudio, VoiceControls } from '../components/VoiceControls';
import { useNow } from '../hooks/useAsync';
import { fmtDuration } from '../lib/format';
import type { DeskController, DeskSnapshot } from './deskController';
import { recordingLabel } from './deskMedia';
import { SelfPreview } from './SelfPreview';

function useSharingFavicon(on: boolean): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link#ia-favicon');
    if (!link) return;
    const prev = link.href;
    if (on) link.href = '/favicon-sharing.svg';
    return () => {
      link.href = prev;
    };
  }, [on]);
}

export function SharingBanner({ ctrl, snap, onPreview }: { ctrl: DeskController; snap: DeskSnapshot; onPreview: () => void }) {
  const now = useNow(1000);
  const [menu, setMenu] = useState(false);
  const tech = snap.created?.assist.name ?? 'your technician';
  const org = snap.created?.org.displayName ?? '';
  return (
    <div role="region" aria-label="Screen sharing status" className="fixed inset-x-0 top-0 z-40 flex min-h-[44px] flex-wrap items-center gap-3 bg-red-800 px-4 py-2 text-white shadow-lg">
      <Button variant="secondary" className="min-h-11 min-w-11 border-white !bg-white !text-red-900 hover:!bg-red-50" onClick={() => ctrl.stopSharing()}>
        Stop sharing
      </Button>
      <p className="flex-1 font-medium" aria-live="polite">
        You are sharing your screen with {tech}
        {org ? ` (${org})` : ''}
      </p>
      {snap.recording && (
        <span className="flex items-center gap-1.5 font-semibold" role="status">
          <span aria-hidden="true" className="h-3 w-3 rounded-full bg-white ring-2 ring-red-300" />
          {recordingLabel(snap)}
        </span>
      )}
      <span className="font-mono" aria-label="Sharing time">
        {fmtDuration(snap.sharingSince ? now - snap.sharingSince : 0)}
      </span>
      <Button size="sm" variant="ghost" className="!text-white hover:!bg-red-700" onClick={onPreview}>
        Annotation preview
      </Button>
      <div className="relative">
        <Button size="sm" variant="ghost" className="!text-white hover:!bg-red-700" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu((m) => !m)}>
          More
        </Button>
        {menu && (
          <div className="absolute right-0 top-full mt-1 w-56 rounded-md bg-white p-1 text-slate-900 shadow-lg dark:bg-slate-900 dark:text-slate-100">
            <button
              type="button"
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => {
                setMenu(false);
                ctrl.revokeConsent();
              }}
            >
              Revoke consent
            </button>
          </div>
        )}
      </div>
      <span className="rounded-md bg-white text-slate-900">
        <ShortcutHelp extra={DESK_SHORTCUTS} />
      </span>
    </div>
  );
}

export function SharingView({ ctrl, snap }: { ctrl: DeskController; snap: DeskSnapshot }) {
  const [preview, setPreview] = useState(false);
  useSharingFavicon(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldIgnoreKey(e) && e.key.toLowerCase() === 'm' && snap.voiceOn) ctrl.toggleMute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrl, snap.voiceOn]);
  // Annotations open the preview automatically the first time they arrive.
  const hasAnnot = snap.annot.shapes.length > 0 || snap.annot.pointer !== null;
  useEffect(() => {
    if (hasAnnot) setPreview(true);
  }, [hasAnnot]);
  const tech = snap.created?.assist.name ?? 'Technician';
  return (
    <>
      <SharingBanner ctrl={ctrl} snap={snap} onPreview={() => setPreview((p) => !p)} />
      <main id="main" className="mx-auto max-w-6xl px-4 pb-8 pt-24">
        <h1 className="mb-1 text-2xl font-semibold">Support session with {tech}</h1>
        <p className="mb-4 text-sm text-slate-700 dark:text-slate-300">
          Stop sharing at any time with the button at the top. Closing this tab also stops sharing.
        </p>
        {snap.notice && <div className="mb-3"><Alert tone="amber">{snap.notice}</Alert></div>}
        {snap.signalStatus === 'reconnecting' && <div className="mb-3"><Alert tone="amber">Connection to the server lost, reconnecting...</Alert></div>}
        {snap.mediaReconnecting && (
          <div className="mb-3">
            <Alert tone="amber">The connection to {tech} was interrupted. Reconnecting... You are still sharing; Stop sharing works at any time.</Alert>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <ChatPanel items={snap.chat} peerName={tech} peerTyping={snap.peerTyping} onSend={(t) => ctrl.sendChat(t)} onTyping={(a) => ctrl.setTyping(a)} />
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <h2 className="mb-2 text-base font-semibold">Voice</h2>
              <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">Your microphone stays off until you turn voice on.</p>
              <VoiceControls on={snap.voiceOn} muted={snap.muted} peerMuted={snap.peerMuted} peerName={tech} onToggle={() => void ctrl.toggleVoice()} onMute={() => ctrl.toggleMute()} />
              <RemoteAudio stream={snap.remoteAudio} />
            </Card>
            <Card>
              <FilePanel
                transfers={snap.transfers}
                peerName={tech}
                canSend
                onSend={(f) => ctrl.sendFile(f)}
                onAccept={(k) => ctrl.acceptFile(k)}
                onReject={(k) => ctrl.rejectFile(k)}
                onCancel={(k) => ctrl.cancelFile(k)}
              />
            </Card>
          </div>
        </div>
      </main>
      <SelfPreview stream={snap.localStream} annot={snap.annot} open={preview} onClose={() => setPreview(false)} />
    </>
  );
}
