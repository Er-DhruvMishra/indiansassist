import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { APP_NAME } from '../config';

/** Centered card layout for the public auth pages. */
export function PublicLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <Link to="/" className="text-lg font-bold text-teal-800 dark:text-teal-300">
          {APP_NAME}
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="mb-5 text-2xl font-semibold">{title}</h1>
          {children}
        </div>
      </main>
      {footer && <footer className="pb-8 text-center text-sm">{footer}</footer>}
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-medium text-teal-800 underline underline-offset-2 dark:text-teal-300">
      {children}
    </Link>
  );
}
