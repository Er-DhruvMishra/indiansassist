/** Chat panel shared by the console and the Desk room (contracts section 8.1). */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ChatItem } from '../lib/link';
import { fmtTime } from '../lib/format';
import { Button, cx } from './ui';

export function ChatPanel({
  items,
  peerName,
  peerTyping,
  disabled,
  onSend,
  onTyping,
  messageAccessory,
}: {
  items: ChatItem[];
  peerName: string;
  peerTyping: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onTyping?: (active: boolean) => void;
  /**
   * Phase F section 6.1 step 2: something drawn beside a message (the P1 room's camera-link QR). Rendered after the
   * message's time; null or absent changes nothing.
   */
  messageAccessory?: (message: ChatItem) => ReactNode;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typing = useRef(false);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  const onChange = (v: string) => {
    setText(v);
    if (!onTyping) return;
    if (!typing.current) {
      typing.current = true;
      onTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typing.current = false;
      onTyping(false);
    }, 2500);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
    if (typing.current) {
      typing.current = false;
      onTyping?.(false);
    }
  };

  return (
    <section aria-label="Chat" className="flex h-full min-h-64 flex-col">
      <h2 className="mb-2 text-base font-semibold">Chat</h2>
      <ol
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        className="mb-2 flex max-h-80 flex-1 flex-col gap-2 overflow-y-auto rounded border border-slate-200 p-2 dark:border-slate-700"
      >
        {items.length === 0 && <li className="text-sm text-slate-600 dark:text-slate-400">No messages yet.</li>}
        {items.map((m) => (
          <li key={m.msgId} className={cx('max-w-[85%] rounded-lg px-3 py-1.5 text-sm', m.mine ? 'self-end bg-teal-700 text-white' : 'self-start bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100')}>
            <span className="sr-only">{m.mine ? 'You' : peerName} said: </span>
            <span className="whitespace-pre-wrap break-words">{m.text}</span>
            <span className={cx('ml-2 text-[10px]', m.mine ? 'text-teal-100' : 'text-slate-600 dark:text-slate-400')}>{fmtTime(m.ts)}</span>
            {messageAccessory?.(m)}
          </li>
        ))}
      </ol>
      <p className="h-5 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
        {peerTyping ? `${peerName} is typing...` : ''}
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          value={text}
          maxLength={4000}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={disabled ? 'Chat opens when the session is active' : 'Type a message'}
          className="min-h-10 flex-1 rounded-md border border-slate-400 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-950"
        />
        <Button type="submit" disabled={disabled || !text.trim()}>
          Send
        </Button>
      </form>
    </section>
  );
}
