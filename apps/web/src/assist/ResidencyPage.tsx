/**
 * /app/residency (docs/specs/phase-e-contracts.md section 6.4; Phase A 6.3, B 11.3, C 13.3, D 7.2 / 13.4): the signed,
 * one-page data residency report. Every field the api sends is shown, in words (never colour alone): the header with
 * the signature (kid, full public key, sha256), where each data category lives, the data that leaves the region,
 * 30-day activity, policies, the audit chain and erasure. Print is one A4 page (`@page` A4 portrait, 12 mm margins,
 * 9 pt); "Download signed JSON" saves the signed report; "Verify a report" checks a pasted or opened JSON file in the
 * browser with `verifyResidencyReport` over the raw parsed JSON, against the published keys of this server or a
 * public key the user pastes. Every Phase B to E key is optional on the wire, so a field an older server does not
 * send is left out rather than shown as zero.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import {
  publicKeyEntry,
  verifyResidencyReport,
  type DataCategoryEntry,
  type DataFlow,
  type PublicKeyLike,
  type ResidencyReport,
} from '@indiansassist/shared';
import { Alert, Badge, Button, Card, PageHeader, Spinner, cx } from '../components/ui';
import { API_URL } from '../config';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, request } from '../lib/api';
import { orgApi } from '../lib/endpoints';
import { formatBytes } from '../lib/fileChunker';
import { fmtDateTime, regionLabel } from '../lib/format';
import { ResidencyErasureSlot } from './console/PhaseFSlots';
import { RESIDENCY_ERASURE_PRINT_CSS } from './erasure/ResidencyErasure';

/**
 * Section 6.4: one A4 page, 12 mm margins, 9 pt body, no navigation chrome. Mounted only while this page is. Phase F
 * section 3.2: the heaviest report (10 flows, a 200-character storage detail, SSO with 5 domains, the AI
 * acknowledgement, the 12 mm erasure block, a 100-character org name) keeps at least 15 mm free, measured by
 * `e2e/enterprise-residency.spec.ts`: tables are set at 8 pt with shortened headings, the flows table prints in two
 * columns (each flow a small block that names its own fields), the storage detail wraps anywhere, and the long
 * single-value lines (organisation, keys, hashes, single sign-on, the chain text) take the full width. No field is
 * dropped and no state is shown by colour alone.
 */
export const RESIDENCY_PRINT_CSS = `
.residency-report .rr-print-only { display: none; }
@media print {
  @page { size: A4 portrait; margin: 12mm; }
  html, body { background: #fff !important; }
  main#main { max-width: none !important; padding: 0 !important; }
  .residency-report, .residency-report * { font-size: 9pt !important; line-height: 1.1 !important; color: #000 !important; }
  .residency-report, .residency-report > div { gap: 2pt !important; }
  .residency-report h1 { font-size: 13pt !important; margin: 0 !important; }
  .residency-report h2 { font-size: 9.5pt !important; font-weight: 700 !important; margin: 0 !important; }
  .residency-report section { border: 0 !important; box-shadow: none !important; padding: 0 !important; margin: 0 !important; background: none !important; break-inside: avoid; }
  .residency-report section > div:first-child { margin-bottom: 0.5pt !important; }
  .residency-report .rr-print-only { display: inline !important; }
  .residency-report table { width: 100%; border-collapse: collapse; }
  .residency-report table, .residency-report table * { font-size: 8pt !important; line-height: 1.07 !important; }
  .residency-report th, .residency-report td { padding: 0.4pt 3pt !important; border-bottom: 0.5pt solid #999 !important; vertical-align: top; }
  .residency-report thead th { text-transform: none !important; letter-spacing: 0 !important; }
  .residency-report dl > div { padding: 0 !important; border: 0 !important; }
  .residency-report .rr-grid { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; column-gap: 8pt !important; row-gap: 0 !important; }
  .residency-report .rr-grid.rr-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
  .residency-report .rr-grid > div { display: block !important; }
  .residency-report .rr-grid > div.rr-wide { grid-column: 1 / -1 !important; }
  .residency-report .rr-grid dt { display: inline !important; font-weight: 600 !important; }
  .residency-report .rr-grid dt::after { content: ': '; }
  .residency-report .rr-grid dd { display: inline !important; }
  .residency-report [data-tone] { padding: 0 2pt !important; border: 0.5pt solid #000; background: none !important; }
  .residency-report .rr-mono { font-size: 7.5pt !important; }
  .residency-report .rr-statement { border: 0.5pt solid #000 !important; background: none !important; padding: 1.5pt 4pt !important; }
  .residency-report .rr-statement * { padding: 0 !important; border: 0 !important; background: none !important; }
  .residency-report .rr-header > div:first-child { display: none !important; }
  .residency-report .rr-nowrap { white-space: nowrap !important; }
  .residency-report .rr-cats { table-layout: fixed; }
  .residency-report .rr-cats td { overflow-wrap: anywhere; }
  .residency-report .rr-cats col.c1 { width: 13%; } .residency-report .rr-cats col.c2 { width: 54%; }
  .residency-report .rr-cats col.c3 { width: 26%; } .residency-report .rr-cats col.c4 { width: 7%; }
  .residency-report .rr-flows, .residency-report .rr-flows tbody { display: block !important; }
  .residency-report .rr-flows colgroup, .residency-report .rr-flows thead { display: none !important; }
  .residency-report .rr-flows tbody { column-count: 2; column-gap: 8pt; }
  .residency-report .rr-flows tr { display: flex !important; flex-wrap: wrap; column-gap: 3pt; border-bottom: 0.5pt solid #999; padding: 0.6pt 0 !important; break-inside: avoid; }
  .residency-report .rr-flows tr > th, .residency-report .rr-flows tr > td { display: block !important; border: 0 !important; padding: 0 !important; overflow-wrap: anywhere; }
  .residency-report .rr-flows tr > th { order: 1; flex: 0 0 100%; }
  .residency-report .rr-flows tr > th > div { display: inline !important; margin-left: 3pt; }
  .residency-report .rr-flows tr > td:nth-child(2) { order: 2; flex: 0 0 auto; }
  .residency-report .rr-flows tr > td:nth-child(4) { order: 3; flex: 1 1 0; min-width: 0; }
  .residency-report .rr-flows tr > td:nth-child(3) { order: 4; flex: 0 0 100%; }
  .residency-report .rr-flows tr > td:nth-child(4) > div { display: inline !important; margin-left: 3pt; }
  .residency-report .rr-screen-only, .residency-report .rr-grid > div.rr-screen-only { display: none !important; }
  .residency-print-hide { display: none !important; }
}
${RESIDENCY_ERASURE_PRINT_CSS}`;

const CATEGORY_LABEL: Record<DataCategoryEntry['category'], string> = {
  identity: 'Identity',
  sessions: 'Sessions',
  recordings: 'Recordings',
  audit: 'Audit log',
  files: 'File transfers',
  fleet: 'Fleet devices',
  summaries: 'AI summaries',
  tickets: 'Ticket pushes',
};

const STORE_LABEL: Record<DataCategoryEntry['stores'][number]['kind'], string> = {
  database: 'Database',
  object_store: 'Object storage',
  presence: 'In memory',
  device: 'On the device',
  none: 'Not stored',
};

const FLOW_KIND_LABEL: Record<DataFlow['kind'], string> = {
  ai_provider: 'AI summaries',
  ticketing: 'Ticketing',
  webhook: 'Webhook',
  sso_idp: 'Sign-on',
  mail: 'Mail',
  vault: 'Credential vault',
  ice: 'STUN/TURN',
  recorder: 'Recorder',
};

/** `leavesRegion` in words (section 6.4: never colour alone). */
export function leavesRegionText(v: DataFlow['leavesRegion']): string {
  return v === 'yes' ? 'Leaves the region' : v === 'no' ? 'Stays in the region' : 'Location unknown';
}

const LEAVES_TONE: Record<DataFlow['leavesRegion'], 'red' | 'green' | 'amber'> = { yes: 'red', no: 'green', unknown: 'amber' };

/** A node that predates Phase D sends none of the fleet keys; the report then has no fleet rows at all. */
export function hasFleet(r: ResidencyReport): boolean {
  return r.devices !== undefined;
}

/** The AI provider in words, from the report's `ai_provider` flow (none when there is no such flow). */
export function aiProviderText(r: ResidencyReport): string | null {
  if (!r.dataFlows) return null;
  const f = r.dataFlows.find((x) => x.kind === 'ai_provider');
  return f ? f.name : 'None (AI summaries are off)';
}

function shortSig(sig: string): string {
  return sig.length > 16 ? `${sig.slice(0, 8)}...${sig.slice(-8)}` : sig;
}

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('grid grid-cols-1 gap-1 border-b border-slate-100 py-1.5 sm:grid-cols-3 dark:border-slate-800', className)}>
      <dt className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</dt>
      <dd className="text-sm break-words sm:col-span-2">{children}</dd>
    </div>
  );
}

/** Label / value pairs; in print each pair is one inline line, two or three to a row. */
function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <dl className={cx('rr-grid grid grid-cols-1 gap-x-6 md:grid-cols-2', cols === 3 && 'rr-cols-3')}>{children}</dl>;
}

/** ISO timestamp as its UTC date (the printed tables have room for a date, not a time). */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="rr-mono break-all font-mono text-xs">{children}</span>;
}

const TH = 'border-b border-slate-300 px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-700 dark:border-slate-700 dark:text-slate-300';
const TD = 'border-b border-slate-100 px-2 py-1 align-top text-sm dark:border-slate-800';

function CategoriesTable({ rows }: { rows: DataCategoryEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="rr-cats w-full">
        <caption className="sr-only">Where each category of data is stored, its retention and count</caption>
        <colgroup>
          <col className="c1" />
          <col className="c2" />
          <col className="c3" />
          <col className="c4" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={TH}>Category</th>
            <th scope="col" className={TH}>
              <span className="rr-screen-only">Store and region</span>
              <span className="rr-print-only">Store, region</span>
            </th>
            <th scope="col" className={TH}>Retention</th>
            <th scope="col" className={cx(TH, 'text-right')}>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.category}>
              <th scope="row" className={cx(TD, 'rr-nowrap text-left font-medium')}>{CATEGORY_LABEL[c.category]}</th>
              <td className={TD}>
                {c.stores.length === 0
                  ? 'Not stored'
                  : c.stores.map((s, i) => (
                      <div key={i}>
                        {s.kind === 'database' && s.detail.includes(s.region) ? s.detail : `${STORE_LABEL[s.kind]}, ${s.region}: ${s.detail}`}
                      </div>
                    ))}
              </td>
              <td className={TD}>{c.retention}</td>
              <td className={cx(TD, 'text-right whitespace-nowrap')}>
                {c.count ?? 'n/a'}
                {c.bytes !== null && c.bytes > 0 && <span className="text-slate-600 dark:text-slate-400"> ({formatBytes(c.bytes)})</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlowsTable({ flows }: { flows: DataFlow[] }) {
  if (flows.length === 0) return <p className="text-sm">No data flow is configured: nothing leaves this deployment.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="rr-flows w-full">
        <caption className="sr-only">Every configured flow of data out of this deployment, enabled or not</caption>
        <colgroup>
          <col className="c1" />
          <col className="c2" />
          <col className="c3" />
          <col className="c4" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={TH}>Flow</th>
            <th scope="col" className={TH}>Region</th>
            <th scope="col" className={TH}>Data sent</th>
            <th scope="col" className={TH}>Status</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f, i) => (
            <tr key={`${f.kind}-${f.name}-${i}`}>
              <th scope="row" className={cx(TD, 'text-left font-medium')}>
                {f.name}
                <div className="text-xs font-normal text-slate-600 dark:text-slate-400">
                  <span className="sr-only">{FLOW_KIND_LABEL[f.kind]}, </span>
                  {f.host ?? ''}
                  {/* On paper the subprocessors line names the third parties. */}
                  <span className="rr-screen-only">{`${f.host ? ', ' : ''}${f.leavesInfrastructure ? 'third party' : 'this deployment'}`}</span>
                </div>
              </th>
              <td className={cx(TD, 'rr-nowrap')}>
                <Badge tone={LEAVES_TONE[f.leavesRegion]}>{leavesRegionText(f.leavesRegion)}</Badge>
              </td>
              <td className={TD}>
                <span className="rr-print-only">Data sent: </span>
                {f.dataSent}
              </td>
              <td className={TD}>
                {f.enabled ? 'Enabled' : 'Configured, disabled'}
                {f.enabled && (f.since || f.enabledBy) && (
                  <span>
                    {f.since ? ` ${day(f.since)}` : ''}
                    {f.enabledBy ? ` by ${f.enabledBy}` : ''}
                  </span>
                )}
                {f.acknowledgement && (
                  <div>
                    Acknowledged ({f.acknowledgement.scope === 'in_geo' ? 'in geography' : 'outside the region'}) by {f.acknowledgement.by},{' '}
                    {day(f.acknowledgement.at)}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The report body (header, tables, activity, policies, chain, erasure); printable on one A4 page. */
export function ResidencyReportView({ r }: { r: ResidencyReport }) {
  const sig = r.signature;
  const ai = aiProviderText(r);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Report" className="rr-header">
        <Grid>
          <Row label="Organisation" className="rr-wide">
            {r.org.name} ({r.org.slug})
          </Row>
          <Row label="Data region">
            <Badge tone="blue">
              <span className="sr-only">Data region: </span>
              {regionLabel(r.org.dataRegion)}
            </Badge>{' '}
            <Mono>{r.org.dataRegion}</Mono>
          </Row>
          <Row label="Served by">
            {regionLabel(r.servedBy.region)}, {r.servedBy.apiOrigin}, node <Mono>{r.servedBy.nodeId}</Mono>
          </Row>
          <Row label="Generated">{fmtDateTime(r.generatedAt)}</Row>
          {sig ? (
            <>
              <Row label="Signed by key">
                <Mono>{sig.kid}</Mono> ({sig.alg}, {sig.domain})
              </Row>
              <Row label="Signature">
                <Mono>{shortSig(sig.sig)}</Mono>
              </Row>
              <Row label="Public key">
                <Mono>{sig.pub}</Mono>
              </Row>
              <Row label="Report sha256" className="rr-wide">
                <Mono>{sig.sha256}</Mono>
              </Row>
            </>
          ) : (
            <Row label="Signature">This server does not sign its reports.</Row>
          )}
        </Grid>
      </Card>

      <div className="rr-statement">
        <Alert tone="blue">{r.statement}</Alert>
      </div>

      {r.dataCategories && (
        <Card title="Where your data lives">
          <CategoriesTable rows={r.dataCategories} />
        </Card>
      )}

      <Card title="Data that leaves the region">
        {r.dataFlows ? (
          <>
            <FlowsTable flows={r.dataFlows} />
            {r.subprocessors && (
              <p className="mt-1 text-sm">
                <span className="font-medium">Subprocessors (third parties receiving data): </span>
                {r.subprocessors.length > 0 ? r.subprocessors.join(', ') : 'none'}
              </p>
            )}
          </>
        ) : (
          <dl>
            <Row label="Third-party STUN/TURN hosts">{r.ice.thirdPartyHosts.length > 0 ? r.ice.thirdPartyHosts.join(', ') : 'None'}</Row>
          </dl>
        )}
      </Card>

      <Card title="Activity in the last 30 days">
        <Grid cols={3}>
          {r.relaySessions !== undefined && (
            <Row label="Relayed sessions (WS relay)">
              {r.relaySessions}
              {r.relayBytes !== undefined && <span className="text-slate-600 dark:text-slate-400"> ({formatBytes(r.relayBytes)})</span>}
            </Row>
          )}
          {r.agentSessions !== undefined && <Row label="Agent sessions">{r.agentSessions}</Row>}
          {r.elevationGrants !== undefined && <Row label="Elevation grants">{r.elevationGrants}</Row>}
          {r.playbookRuns !== undefined && <Row label="Playbook runs">{r.playbookRuns}</Row>}
          {hasFleet(r) && <Row label="Unattended sessions">{r.unattendedSessions30d ?? 0}</Row>}
          {hasFleet(r) && <Row label="Wake attempts">{r.wakeAttempts30d ?? 0}</Row>}
          {hasFleet(r) && <Row label="Device actions">{r.deviceActions30d ?? 0}</Row>}
          {r.activity30d && (
            <>
              <Row label="AI summaries">{r.activity30d.summaries}</Row>
              <Row label="Ticket pushes">{r.activity30d.ticketPushes}</Row>
              <Row label="SSO sign-ins">{r.activity30d.ssoLogins}</Row>
            </>
          )}
          {hasFleet(r) && (
            <Row label="Enrolled devices">
              {r.devices ?? 0}
              {r.onlineDevices !== undefined && <span className="text-slate-600 dark:text-slate-400"> ({r.onlineDevices} online now)</span>}
            </Row>
          )}
          {hasFleet(r) && (
            <Row label="AMT over plain HTTP">
              {r.amtPlainHttpDevices ? (
                <>
                  <Badge tone="amber">{r.amtPlainHttpDevices} device(s)</Badge>{' '}
                  <span>AMT on these devices is reached without TLS; their credentials and console traffic cross the LAN in the clear.</span>
                </>
              ) : (
                'None'
              )}
            </Row>
          )}
        </Grid>
      </Card>

      {/* On paper these counts are already in "Where your data lives" and the flows table. */}
      <Card title="Holdings" className="rr-screen-only">
        <Grid cols={3}>
          <Row label="Users, tokens, sessions">
            {r.counts.users} users, {r.counts.tokens} tokens, {r.counts.sessions} sessions
          </Row>
          <Row label="Recordings">
            {r.counts.recordings} ({formatBytes(r.counts.recordingBytes)})
          </Row>
          <Row label="Object storage">
            {r.storage.driver}, bucket <Mono>{r.storage.bucket}</Mono>, prefix <Mono>{r.storage.prefix}</Mono>
          </Row>
          <Row label="STUN / TURN">
            {r.ice.stunUrls.length + r.ice.turnUrls.length > 0 ? <Mono>{[...r.ice.stunUrls, ...r.ice.turnUrls].join(', ')}</Mono> : 'None configured'}
          </Row>
        </Grid>
      </Card>

      <Card title="Policies">
        <Grid>
          {r.extensionPolicy && (
            <>
              <Row label="Extension relay fallback">{r.extensionPolicy.allowRelayFallback ? 'Allowed' : 'Not allowed'}</Row>
              <Row label="Revealed-field recording">{r.extensionPolicy.recordRevealed ? 'Recorded' : 'Not recorded'}</Row>
            </>
          )}
          <Row label="Recording retention">{r.retention.recordings}</Row>
          {r.sso && (
            <Row label="Single sign-on" className="rr-wide">
              {r.sso.protocol ? `${r.sso.protocol.toUpperCase()}, ${r.sso.enabled ? 'enabled' : 'disabled'}` : 'Not configured'}
              {', '}
              {r.sso.required ? 'required for sign-in' : 'not required'}
              {r.sso.verifiedDomains.length > 0 && `; verified domains: ${r.sso.verifiedDomains.join(', ')}`}
            </Row>
          )}
          {ai !== null && <Row label="AI provider">{ai}</Row>}
          {r.recorder && <Row label="Server recorder">{r.recorder.enabled ? 'Enabled on this node' : 'Not enabled'}</Row>}
        </Grid>
      </Card>

      <Card title="Audit chain and erasure">
        <Grid>
          <Row label="Entries">
            {r.chain.length} ({r.retention.auditEntries})
          </Row>
          <Row label="Last verified">
            {r.chain.lastVerifiedAt ? (
              <>
                {fmtDateTime(r.chain.lastVerifiedAt)}{' '}
                <Badge tone={r.chain.lastVerifiedOk ? 'green' : 'red'}>{r.chain.lastVerifiedOk ? 'intact' : 'broken'}</Badge>
              </>
            ) : (
              'never'
            )}
          </Row>
          <Row label="Tail" className="rr-wide">
            <Mono>{r.chain.tail ?? 'empty'}</Mono>
          </Row>
          <Row label="Last anchor">
            {r.chain.lastAnchor ? (
              <>
                seq {r.chain.lastAnchor.seq}, key <Mono>{r.chain.lastAnchor.kid}</Mono>, {fmtDateTime(r.chain.lastAnchor.ts)}
              </>
            ) : (
              'none yet'
            )}
          </Row>
          <Row label="Personal data in the chain" className="rr-wide">{r.retention.piiInChain}</Row>
          {/* Phase F sections 3.2b2, 5.7: the erasure line (stream erasure), 12 mm in print. */}
          <ResidencyErasureSlot erasure={r.erasure} />
        </Grid>
      </Card>
    </div>
  );
}

type KeySource = 'published' | 'pasted';
type VerifyOutcome = { ok: true; text: string } | { ok: false; text: string };

const CAUSE_TEXT: Record<'unknown_kid' | 'bad_signature' | 'malformed', string> = {
  unknown_kid: 'it was signed by a key that is not in the key list',
  bad_signature: 'its content or signature was changed after signing',
  malformed: 'it is not a signed residency report',
};

/** The published keys of this server (the well-known document lists retired keys too, section 6.3d). */
export async function fetchPublishedKeys(): Promise<PublicKeyLike[]> {
  const res = await fetch(`${API_URL}/.well-known/indiansassist.json`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const doc = (await res.json()) as { keys?: { kid?: unknown; pub?: unknown }[] };
  return (doc.keys ?? []).filter((k): k is { kid: string; pub: string } => typeof k.kid === 'string' && typeof k.pub === 'string');
}

/** Verifies JSON text over its raw parse (never a schema-parsed copy, section 6.3c). */
export function verifyReportText(text: string, keys: readonly PublicKeyLike[]): VerifyOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, text: 'Not verified: the text is not JSON.' };
  }
  const r = verifyResidencyReport(raw, keys);
  if (!r.ok) return { ok: false, text: `Not verified: ${CAUSE_TEXT[r.cause ?? 'malformed']}.` };
  const o = raw as { signature: { kid: string; sha256: string }; generatedAt?: unknown; org?: { name?: unknown } };
  const s = o.signature;
  const who = typeof o.org?.name === 'string' ? ` for ${o.org.name}` : '';
  const when = typeof o.generatedAt === 'string' ? `, generated ${fmtDateTime(o.generatedAt)}` : '';
  return { ok: true, text: `Verified: the report${who}${when} was signed by key ${s.kid} and is unchanged (sha256 ${s.sha256}).` };
}

export function VerifyPanel() {
  const [text, setText] = useState('');
  const [source, setSource] = useState<KeySource>('published');
  const [pub, setPub] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const uid = useId();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setOutcome(null);
  };

  const verify = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      let keys: PublicKeyLike[];
      if (source === 'pasted') {
        try {
          const e = publicKeyEntry(pub.trim());
          keys = [{ kid: e.kid, pub: pub.trim() }];
        } catch {
          setOutcome({ ok: false, text: 'Not verified: the public key is not a base64url Ed25519 key (43 characters).' });
          return;
        }
      } else {
        try {
          keys = await fetchPublishedKeys();
        } catch (e) {
          setOutcome({ ok: false, text: `Not verified: the published keys could not be read (${errorMessage(e)}).` });
          return;
        }
      }
      setOutcome(verifyReportText(text, keys));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Verify a report" className="no-print">
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          Paste a signed report (the downloaded JSON) or open its file. The signature is checked here, in your browser, over the exact JSON.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-text`} className="text-sm font-medium">
            Signed report JSON
          </label>
          <textarea
            id={`${uid}-text`}
            className="min-h-28 w-full rounded-md border border-slate-400 bg-white px-3 py-2 font-mono text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOutcome(null);
            }}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-file`} className="text-sm font-medium">
            Or open a JSON file
          </label>
          <input id={`${uid}-file`} type="file" accept="application/json,.json" className="text-sm" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">Check against</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${uid}-src`} checked={source === 'published'} onChange={() => setSource('published')} />
            The keys this server publishes (including retired keys)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${uid}-src`} checked={source === 'pasted'} onChange={() => setSource('pasted')} />
            A public key I paste
          </label>
        </fieldset>
        {source === 'pasted' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-pub`} className="text-sm font-medium">
              Public key (base64url)
            </label>
            <input
              id={`${uid}-pub`}
              className="min-h-10 w-full rounded-md border border-slate-400 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              value={pub}
              onChange={(e) => setPub(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
        <div>
          <Button onClick={() => void verify()} disabled={busy || text.trim() === '' || (source === 'pasted' && pub.trim() === '')}>
            {busy ? 'Verifying' : 'Verify'}
          </Button>
        </div>
        <div aria-live="polite">{outcome && <Alert tone={outcome.ok ? 'green' : 'red'}>{outcome.text}</Alert>}</div>
      </div>
    </Card>
  );
}

/** `residency-<slug>-<YYYY-MM-DD>.json` (the api's download name). */
export function residencyFileName(slug: string, generatedAt: string): string {
  return `residency-${slug}-${generatedAt.slice(0, 10)}.json`;
}

function filenameFrom(disposition: string | null): string | null {
  const m = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return m ? m[1]! : null;
}

export function ResidencyPage() {
  usePageTitle('Data residency');
  const report = useAsync(() => orgApi.residency(), []);
  const r = report.data;
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await request<Response>('GET', '/orgs/current/residency/signed.json', { raw: true });
      const text = await res.text();
      let name = filenameFrom(res.headers.get('Content-Disposition'));
      if (!name) {
        const parsed = JSON.parse(text) as { org?: { slug?: string }; generatedAt?: string };
        name = residencyFileName(parsed.org?.slug ?? 'org', parsed.generatedAt ?? new Date().toISOString());
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadError(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="residency-report flex flex-col gap-3">
      <style>{RESIDENCY_PRINT_CSS}</style>
      <PageHeader title="Data residency report">
        <Button variant="secondary" className="no-print" onClick={() => window.print()} disabled={!r}>
          Print
        </Button>
        <Button variant="secondary" className="no-print" onClick={() => void download()} disabled={!r || downloading}>
          {downloading ? 'Preparing download' : 'Download signed JSON'}
        </Button>
        <Button
          variant="secondary"
          className="no-print"
          aria-expanded={verifyOpen}
          aria-controls={panelId}
          onClick={() => {
            setVerifyOpen((o) => !o);
            setTimeout(() => panelRef.current?.scrollIntoView?.({ block: 'start' }), 0);
          }}
        >
          Verify a report
        </Button>
      </PageHeader>
      {downloadError && <Alert>{`The signed report could not be downloaded: ${downloadError}`}</Alert>}
      {report.loading && <Spinner label="Generating report" />}
      {Boolean(report.error) && <Alert>{errorMessage(report.error)}</Alert>}
      {r && <ResidencyReportView r={r} />}
      <div id={panelId} ref={panelRef} hidden={!verifyOpen} className="residency-print-hide">
        {verifyOpen && <VerifyPanel />}
      </div>
    </div>
  );
}
