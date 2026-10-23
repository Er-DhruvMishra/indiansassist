/** Copy-to-clipboard button that announces "Copied" for 2 s (section 6.13 step 4). */
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { Button, type ButtonProps } from './ui';

export function CopyButton({
  text,
  label,
  againLabel,
  onCopied,
  ...rest
}: Omit<ButtonProps, 'onClick' | 'children'> & {
  text: string;
  label: string;
  /** Label once copied at least once (e.g. "Copy token again"). */
  againLabel?: string;
  onCopied?: (ok: boolean) => void;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    setCount((c) => c + 1);
    onCopied?.(ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button {...rest} onClick={() => void onClick()}>
        {count > 0 && againLabel ? againLabel : label}
      </Button>
      <span aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed, select and copy manually' : ''}
      </span>
    </span>
  );
}
