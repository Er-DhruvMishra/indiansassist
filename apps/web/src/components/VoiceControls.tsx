/** Voice toggle + mute (getUserMedia audio). Remote audio plays through a hidden audio element. */
import { useEffect, useRef } from 'react';
import { Button } from './ui';

export function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play?.()?.catch(() => undefined);
  }, [stream]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

export function VoiceControls({
  on,
  muted,
  peerMuted,
  peerName,
  disabled,
  onToggle,
  onMute,
  labels,
}: {
  on: boolean;
  muted: boolean;
  peerMuted: boolean | null;
  peerName: string;
  disabled?: boolean;
  onToggle: () => void;
  /** Omitted when the toggle itself mutes (P3: the toggle enables / disables the one mic track). */
  onMute?: () => void;
  labels?: { on: string; off: string };
}) {
  return (
    <section aria-label="Voice" className="flex flex-wrap items-center gap-2">
      <Button variant={on ? 'secondary' : 'primary'} size="sm" disabled={disabled} onClick={onToggle} aria-pressed={on}>
        {on ? (labels?.off ?? 'Turn voice off') : (labels?.on ?? 'Turn voice on')}
      </Button>
      {on && onMute && (
        <Button variant="secondary" size="sm" onClick={onMute} aria-pressed={muted}>
          {muted ? 'Unmute microphone' : 'Mute microphone'}
        </Button>
      )}
      <span className="text-xs text-slate-600 dark:text-slate-400" aria-live="polite" data-testid="peer-voice">
        {peerMuted === null ? '' : peerMuted ? `${peerName} is muted` : `${peerName}'s microphone is on`}
      </span>
    </section>
  );
}
