/**
 * /join (contracts section 6.13): reads `t` from the fragment (fallback `?t=`), removes it from the URL at
 * once, looks the token up, shows the technician's org, a prominent Copy token button (then "Copy token
 * again"), the manual code / link field fallback with Continue, and Join support session. A `p2_extension`
 * token renders the extension branch instead (Phase B 2.1, `JoinP2`).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { STORAGE_KEYS, isValidShortCode, type PublicToken } from '@indiansassist/shared';
import { CopyButton } from '../components/CopyButton';
import { Alert, Badge, Button, Field, Input, Spinner } from '../components/ui';
import { useNow } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { isApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { safeAccent } from '../lib/contrast';
import { tokensApi } from '../lib/endpoints';
import { fmtTier, regionLabel } from '../lib/format';
import { parseJoinInput, readTokenParam, type JoinCode } from '../lib/joinInput';
import { navigateTo, regionDecision } from '../lib/region';
import { JOIN_LABEL_KEY, readStore, writeStore } from '../lib/storage';
import { saveJoinBrand } from './brand';
import { DeskLayout } from './DeskLayout';
import { JoinP2 } from './JoinP2';
import { JoinP3 } from './JoinP3';
import { AGENT_SEEN_KEY } from './agentDownload';

type LookupError = { message: string; retry?: boolean };

const GONE: Record<string, string> = {
  expired: 'This link has expired. Ask your technician for a new one.',
  used: 'This link was already used. Ask your technician for a new one.',
  revoked: 'This link was revoked by your technician.',
};

export function explainLookupError(e: unknown, code: JoinCode): LookupError | { redirect: string } {
  if (isApiError(e)) {
    if (e.status === 400) return { message: 'This link is not a valid IndiansAssist link.' };
    if (e.status === 404)
      return {
        message:
          code.kind === 'short_code'
            ? 'This code is not valid, has already been used, or belongs to another region; use the full link or ask your technician for a new code. Codes only work on your organisation\'s region site.'
            : 'This code is not valid, has already been used, or belongs to another region; use the full link or ask your technician for a new code.',
      };
    if (e.status === 410) return { message: GONE[String(e.details?.status)] ?? 'This link can no longer be used.' };
    if (e.status === 421) {
      const d = regionDecision(e.details, `/join#t=${encodeURIComponent(code.value)}`);
      if (d.kind === 'redirect') return { redirect: d.url };
      return { message: d.manualOrigin ? `${d.message} Region site: ${d.manualOrigin}` : d.message };
    }
    if (e.status === 429) {
      const s = Number(e.details?.retryAfterSec);
      return { message: `Too many attempts, try again in ${Number.isFinite(s) ? s : 60} s.` };
    }
  }
  return { message: 'Could not reach the server.', retry: true };
}

export function JoinPage() {
  usePageTitle('Join a support session');
  const location = useLocation();
  const navigate = useNavigate();
  const now = useNow(1000);
  const [code, setCode] = useState<JoinCode | null>(null);
  const [info, setInfo] = useState<PublicToken | null>(null);
  const [error, setError] = useState<LookupError | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [label, setLabel] = useState(() => readStore('session', JOIN_LABEL_KEY) ?? '');
  const took = useRef(false);
  const [kept, setKept] = useState(false);

  const lookup = async (c: JoinCode) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    setCode(c);
    try {
      setInfo(await tokensApi.publicLookup(c.value));
    } catch (e) {
      const r = explainLookupError(e, c);
      if ('redirect' in r) return navigateTo(r.redirect);
      setError(r);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (took.current) return;
    took.current = true;
    // Phase C 2.5 L3 / J5: the agent opens /join?kept=1 once after the Desk chose Keep; only this sets the flag.
    if (new URLSearchParams(location.search).get('kept') === '1') {
      writeStore('local', AGENT_SEEN_KEY, '1');
      setKept(true);
    }
    const t = readTokenParam(location.hash, location.search);
    if (!t) return;
    // Step 1: the bearer leaves the URL bar, the history entry and any Referer immediately.
    navigate('/join', { replace: true });
    const c = parseJoinInput(t);
    if (c) void lookup(c);
    else setError({ message: 'This link is not a valid IndiansAssist link.' });
  }, []);

  const onManual = (e: FormEvent) => {
    e.preventDefault();
    const c = parseJoinInput(manual);
    if (!c) return setManualError('Enter the 12-digit code, the full token or the full link.');
    if (c.kind === 'short_code' && !isValidShortCode(c.value))
      return setManualError('This code looks mistyped. Check the 12 digits and try again.');
    setManualError(null);
    void lookup(c);
  };

  const join = async () => {
    if (!code || !info) return;
    await copyText(code.value);
    writeStore('session', STORAGE_KEYS.joinToken, code.value);
    writeStore('session', STORAGE_KEYS.joinSignal, info.signalUrl);
    writeStore('session', JOIN_LABEL_KEY, label.trim());
    saveJoinBrand(info.org);
    navigate('/room/new');
  };

  const secondsLeft = info ? Math.max(0, Math.round((new Date(info.expiresAt).getTime() - now) / 1000)) : 0;
  const accent = safeAccent(info?.org.accentColor);
  const showManual = !info && !busy;

  return (
    <DeskLayout brand={info?.org ?? null}>
      <h1 className="mb-4 text-2xl font-semibold">Join a support session</h1>
      {kept && <Alert tone="green">IndiansAssist is kept on this computer. Next time, support links open it directly.</Alert>}
      {busy && <Spinner label="Checking your link" />}
      {error && (
        <div className="mb-4 flex flex-col gap-2">
          <Alert>{error.message}</Alert>
          {error.retry && code && (
            <Button variant="secondary" onClick={() => void lookup(code)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {info && code && (
        <section aria-label="Support session details" className="mb-6 flex flex-col gap-4 rounded-lg border-t-4 bg-white p-5 shadow-sm dark:bg-slate-900" style={{ borderTopColor: accent }}>
          <div className="flex items-center gap-3">
            {info.org.logoData?.startsWith('data:image/') && <img src={info.org.logoData} alt="" className="h-10 w-10 rounded object-contain" />}
            <div>
              <p className="text-lg font-semibold">{info.org.displayName}</p>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                {info.technician ? `${info.technician.name} wants to help you` : 'Your technician wants to help you'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="blue">{fmtTier(info.tier)}</Badge>
            <Badge>Hosted in {regionLabel(info.region)}</Badge>
            <Badge tone={secondsLeft > 60 ? 'green' : 'amber'}>
              {secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Expired'}
            </Badge>
          </div>
          {info.tier === 'p3_portable' ? (
            <JoinP3 info={info} code={code.value} accent={accent} expired={secondsLeft === 0} />
          ) : info.tier === 'p2_extension' ? (
            <JoinP2 info={info} code={code.value} accent={accent} expired={secondsLeft === 0} />
          ) : (
            <>
              <div>
                <CopyButton text={code.value} label="Copy token" againLabel="Copy token again" size="lg" variant="secondary" />
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Keep the token on your clipboard in case your technician asks for it.</p>
              </div>
              {info.joinSupported ? (
                <>
                  <Field label="Your name (optional, shown to the technician)">
                    {(p) => <Input id={p.id} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoComplete="name" />}
                  </Field>
                  <Button size="lg" onClick={() => void join()} disabled={secondsLeft === 0} style={secondsLeft > 0 ? { backgroundColor: accent } : undefined}>
                    Join support session
                  </Button>
                  <p className="text-xs text-slate-600 dark:text-slate-400">Nothing is shared yet. You will see exactly what is requested and choose what to share.</p>
                </>
              ) : (
                <Alert tone="amber">The IndiansAssist client for this package is not available yet.</Alert>
              )}
            </>
          )}
        </section>
      )}
      {showManual && (
        <form onSubmit={onManual} className="flex flex-col gap-3" aria-label="Enter a support code">
          <Field label="Paste your support code or link" hint="The 12-digit code (for example 4821 9365 7715), the full token, or the whole link." error={manualError}>
            {(p) => (
              <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" spellCheck={false} />
            )}
          </Field>
          <Button type="submit">Continue</Button>
        </form>
      )}
    </DeskLayout>
  );
}
