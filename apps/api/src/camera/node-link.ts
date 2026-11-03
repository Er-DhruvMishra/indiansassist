/**
 * Phase F section 6.2c: a camera REST call (link, revoke, snapshot) may land on any api node, while the camera lives
 * on the session's owner node (`Live.camera`). With a multi-node presence driver this module asks the owner over its
 * own presence channel `camera:<nodeId>` (the bridge's `node:<id>` messages are a closed set owned elsewhere): `info`
 * reads the camera and the recorder's camera support, `end` ends a connected camera. Single-node: never used.
 */
import { getSession } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import type { SignalHub } from '../signal/hub.js';
import { cameraUnrecordable, endCamera, localCamera } from '../signal/camera.js';

export type CameraInfo = {
  /** The owner node holds a live entry for the session. */
  live: boolean;
  camera: { cameraId: string; started: boolean } | null;
  unrecordable: boolean;
};

type Req = { k: 'req'; id: string; from: string; op: 'info' | 'end'; sessionId: string; cameraId?: string };
type Res = { k: 'res'; id: string; value: unknown };

const RPC_TIMEOUT_MS = 1_500;
const channel = (nodeId: string) => `camera:${nodeId}`;

export class CameraNodeLink {
  private unsub: (() => Promise<void>) | null = null;
  private readonly pending = new Map<string, (v: unknown) => void>();
  private seq = 0;

  constructor(private readonly ctx: AppContext) {}

  private get hub(): SignalHub {
    return this.ctx.hub;
  }

  async start(): Promise<void> {
    if (!this.ctx.presence.multiNode) return;
    this.unsub = await this.ctx.presence.subscribe(channel(this.ctx.config.nodeId), (m) => {
      void this.onMessage(m as Req | Res).catch((err: unknown) =>
        this.ctx.log.error({ err }, 'camera node message failed'),
      );
    });
  }

  async stop(): Promise<void> {
    await this.unsub?.().catch(() => undefined);
    this.unsub = null;
    for (const r of this.pending.values()) r(null);
    this.pending.clear();
  }

  private publish(node: string, msg: Req | Res): void {
    this.ctx.presence
      .publish(channel(node), msg)
      .catch((err: unknown) => this.ctx.log.warn({ err }, 'camera node publish failed'));
  }

  private async onMessage(m: Req | Res): Promise<void> {
    if (!m || typeof m !== 'object') return;
    if (m.k === 'res') {
      this.pending.get(m.id)?.(m.value);
      this.pending.delete(m.id);
      return;
    }
    if (m.k !== 'req') return;
    let value: unknown = null;
    if (m.op === 'info') value = this.localInfo(m.sessionId);
    else if (m.op === 'end') {
      const cam = localCamera(this.hub, m.sessionId);
      if (cam && cam.cameraId === m.cameraId) await endCamera(this.hub, cam.live, 'assist');
      value = Boolean(cam && cam.cameraId === m.cameraId);
    }
    this.publish(m.from, { k: 'res', id: m.id, value });
  }

  localInfo(sessionId: string): CameraInfo {
    const live = this.hub.live.get(sessionId);
    if (!live) return { live: false, camera: null, unrecordable: false };
    const cam = localCamera(this.hub, sessionId);
    return {
      live: true,
      camera: cam ? { cameraId: cam.cameraId, started: cam.started } : null,
      unrecordable: cameraUnrecordable(this.hub, live),
    };
  }

  /** The owner node of a session other than this one, when it is alive (multi-node only). */
  private async remoteOwner(sessionId: string): Promise<string | null> {
    if (!this.ctx.presence.multiNode || this.hub.live.has(sessionId)) return null;
    const s = await getSession(this.ctx.db, sessionId);
    if (!s || s.nodeId === this.ctx.config.nodeId || !(await this.ctx.presence.isNodeAlive(s.nodeId))) return null;
    return s.nodeId;
  }

  private rpc(node: string, req: Omit<Req, 'k' | 'id' | 'from'>): Promise<unknown> {
    const id = `${this.ctx.config.nodeId}:${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.publish(node, { k: 'req', id, from: this.ctx.config.nodeId, ...req });
    });
  }

  /** The camera state of a session, from this node or its owner. */
  async info(sessionId: string): Promise<CameraInfo> {
    const owner = await this.remoteOwner(sessionId);
    if (!owner) return this.localInfo(sessionId);
    const v = (await this.rpc(owner, { op: 'info', sessionId })) as CameraInfo | null;
    return v ?? { live: false, camera: null, unrecordable: false };
  }

  /** Ends a connected camera here or on its owner node; true when a camera was ended. */
  async end(sessionId: string, cameraId: string): Promise<boolean> {
    const owner = await this.remoteOwner(sessionId);
    if (!owner) {
      const cam = localCamera(this.hub, sessionId);
      if (!cam || cam.cameraId !== cameraId) return false;
      await endCamera(this.hub, cam.live, 'assist');
      return true;
    }
    return (await this.rpc(owner, { op: 'end', sessionId, cameraId })) === true;
  }
}
