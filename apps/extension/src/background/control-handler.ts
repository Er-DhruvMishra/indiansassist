/**
 * `ia.control` request handling (sections 4.6, 5): direction rule, `id` de-duplication (30 s), the two op buckets,
 * strict schema validation (`bad_args`), the consent gate, dispatch, exactly one `ctl.res` per request, and the
 * Desk's `tab.action` attestation for every tab op whose request passed validation (one entry per request).
 */
import {
  LIMITS,
  TAB_ACTION_KINDS,
  controlRequestSchema,
  hostOf,
  isControlOp,
  isWireHost,
  opIdFor,
  type ControlErrorCode,
  type ControlRequest,
  type ControlResponse,
  type TabActionKind,
} from '@indiansassist/shared';
import { ControlError, gateOp } from './gate';
import { RecentIds, TokenBucket } from './rate';
import type { ControlHost } from './control-ops';
import { runControlOp } from './control-ops';

const TAB_KINDS = new Set<string>(TAB_ACTION_KINDS);
const INPUT_KIND = { 'input.pointer': 'pointer', 'input.key': 'key', 'input.scroll': 'scroll', 'input.fill': 'fill' } as const;

export function wireHost(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const h = hostOf(url);
  return h && isWireHost(h) ? h : undefined;
}

export class ControlHandler {
  private readonly ids: RecentIds;
  private readonly ops: TokenBucket;
  private readonly moves: TokenBucket;

  constructor(
    private readonly host: ControlHost,
    now: () => number = Date.now,
  ) {
    this.ids = new RecentIds(30000, now);
    this.ops = new TokenBucket(LIMITS.controlOpsPerSec, LIMITS.controlOpsBurst, now);
    this.moves = new TokenBucket(LIMITS.pointerMovesPerSec, LIMITS.pointerMovesPerSec, now);
  }

  /** One inbound `ia.control` / `control.relay` message from the Assist. Never throws. */
  async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as { t?: unknown; id?: unknown; op?: unknown; args?: unknown };
    if (m.t !== 'ctl.req') return; // wrong direction (a ctl.res / ctl.event at the Desk) is dropped
    if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 40) return;
    if (this.ids.seen(m.id)) return;
    const id = m.id;
    if (this.host.finishing) return this.fail(id, 'not_allowed', 'sharing is ending');
    const isMove = m.op === 'input.pointer' && (m.args as { kind?: unknown } | undefined)?.kind === 'move';
    if (!(isMove ? this.moves : this.ops).take()) return this.fail(id, 'rate_limited', 'too many requests');
    if (!isControlOp(m.op)) return this.fail(id, 'not_supported', 'unknown op');
    const parsed = controlRequestSchema.safeParse(raw);
    if (!parsed.success) {
      if (TAB_KINDS.has(m.op)) this.attestTab(m.op as TabActionKind, id, (m.args ?? {}) as Record<string, unknown>, false, 'bad_args');
      return this.fail(id, 'bad_args', (parsed.error.issues[0]?.message ?? 'invalid arguments').slice(0, 200));
    }
    await this.run(parsed.data as ControlRequest);
  }

  private async run(req: ControlRequest): Promise<void> {
    const opId = opIdFor(this.host.sessionId(), req.id);
    const refusal = gateOp(req, this.host.gateContext());
    if (refusal) {
      this.afterRefusal(req, opId, refusal);
      return this.fail(req.id, refusal.code, refusal.message);
    }
    try {
      const result = await runControlOp(req, opId, this.host);
      if (TAB_KINDS.has(req.op)) this.attestTab(req.op as TabActionKind, req.id, req.args as Record<string, unknown>, true);
      this.reply({ t: 'ctl.res', id: req.id, ok: true, result, ts: Date.now() });
    } catch (e) {
      const err = e instanceof ControlError ? e : new ControlError('internal', 'the operation failed');
      this.afterRefusal(req, opId, err);
      this.fail(req.id, err.code, err.message);
    }
  }

  /** Locally refused ops are attested too (tab ops, backstage, refused input counts). */
  private afterRefusal(req: ControlRequest, opId: string, err: ControlError): void {
    if (TAB_KINDS.has(req.op)) this.attestTab(req.op as TabActionKind, req.id, req.args as Record<string, unknown>, false, err.code);
    else if (req.op === 'backstage.enter') {
      const host = wireHost(req.args.url);
      if (host) this.host.attest('backstage.enter', { host, opId, ok: false, error: err.code });
    } else if (req.op in INPUT_KIND) {
      const a = req.args as { tabId: number };
      this.host.recordInput(a.tabId, INPUT_KIND[req.op as keyof typeof INPUT_KIND], true);
    }
  }

  private attestTab(kind: TabActionKind, reqId: string, args: Record<string, unknown>, ok: boolean, error?: ControlErrorCode): void {
    const data: Record<string, unknown> = { kind, opId: opIdFor(this.host.sessionId(), reqId), ok };
    if (typeof args.tabId === 'number') data.tabId = args.tabId;
    if (Array.isArray(args.tabIds) && args.tabIds.length > 0 && args.tabIds.length <= LIMITS.tabsCloseMax && args.tabIds.every((x) => Number.isInteger(x) && x >= 0))
      data.tabIds = args.tabIds;
    const host = wireHost(args.url);
    if (host) data.host = host;
    if (error) data.error = error;
    this.host.countTabAction();
    this.host.attest('tab.action', data);
  }

  private fail(id: string, code: ControlErrorCode, message: string): void {
    this.reply({ t: 'ctl.res', id, ok: false, error: { code, message: message.slice(0, 200) }, ts: Date.now() });
  }

  private reply(res: ControlResponse): void {
    this.host.send(res);
  }
}
