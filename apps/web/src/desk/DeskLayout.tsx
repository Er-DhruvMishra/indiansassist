/** Desk page chrome: no cross-origin resources (contracts section 12), one landmark set. */
import type { ReactNode } from 'react';
import { ShortcutHelp, type Shortcut } from '../components/ShortcutHelp';
import { APP_NAME } from '../config';

export function DeskLayout({ children, wide, shortcuts }: { children: ReactNode; wide?: boolean; shortcuts?: Shortcut[] }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <span className="text-lg font-bold text-teal-800 dark:text-teal-300">{APP_NAME}</span>
        <ShortcutHelp extra={shortcuts} />
      </header>
      <main id="main" className={`mx-auto w-full flex-1 px-4 py-8 ${wide ? 'max-w-6xl' : 'max-w-xl'}`}>
        {children}
      </main>
      <footer className="pb-6 text-center text-xs text-slate-600 dark:text-slate-400">
        The technician can only see what you choose to share and cannot control your mouse or keyboard.
      </footer>
    </div>
  );
}
