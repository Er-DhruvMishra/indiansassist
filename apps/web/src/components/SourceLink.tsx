/**
 * AGPL-3.0-only section 13: everyone who uses the web app over a network is offered the Corresponding Source. The
 * link sits in the footer of the console (AppShell), the Desk pages (DeskLayout) and the public pages (PublicLayout).
 * It opens in a new tab so a live session is never navigated away from. `VITE_SOURCE_URL` lets an operator who runs a
 * modified version point at their own published source, as section 13 requires of them.
 */
import { SOURCE_URL } from '../config';
import { cx } from './ui';

export function SourceLink({ className }: { className?: string }) {
  return (
    <a
      href={SOURCE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cx('underline underline-offset-2 hover:text-slate-900 dark:hover:text-slate-100', className)}
      data-testid="source-link"
    >
      Source code
      <span className="sr-only"> (AGPL-3.0, opens in a new tab)</span>
    </a>
  );
}

/** The one-line footer the layouts render: the source link and the licence name. */
export function SourceFooter({ className }: { className?: string }) {
  return (
    <p className={cx('text-xs text-slate-600 dark:text-slate-400', className)}>
      <SourceLink /> <span aria-hidden="true">·</span> AGPL-3.0
    </p>
  );
}
