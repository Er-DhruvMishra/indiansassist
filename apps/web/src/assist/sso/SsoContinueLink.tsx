/**
 * "Continue with <IdP>" (Phase E section 13.4): a real navigation to the api's begin route. The console sets
 * `<meta name="referrer" content="no-referrer">`, so this link opts into `referrerpolicy="origin"`: when the console
 * and the api are same-site but not same-origin (development), the begin route's section 3.4 O1 guard needs a Referer
 * whose origin is WEB_ORIGIN. Only the origin is sent, never a path.
 */
export function SsoContinueLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      referrerPolicy="origin"
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-teal-700 px-5 text-base font-medium text-white hover:bg-teal-800"
    >
      {label}
    </a>
  );
}

/** Script-initiated navigation with the same Referer rule as the link (the test sign-in button). */
export function navigateWithOriginReferrer(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.referrerPolicy = 'origin';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
