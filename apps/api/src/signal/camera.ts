/**
 * Phase F stream camera (docs/specs/phase-f-contracts.md sections 6.4, 6.5a): the phone camera's `/signal` side.
 * `camera.hello` resolves a link code or a resume key to a live session; `camera.ready` and `camera.stop` report the
 * track; `routeCameraWebrtc` relays the camera <-> Assist peer connection (`peer: 'camera'`) and
 * `routeCameraRecorderWebrtc` the camera <-> recorder one (`peer: 'recorder'` from the camera side). The foundation
 * lands the dispatch (hub.ts, relay.ts) and these stubs, which refuse everything with `error forbidden`; the camera
 * stream fills them without editing hub.ts or relay.ts.
 */
import { WS_CLOSE, type SignalOf } from '@indiansassist/shared';
import type { Conn, Live } from './conn.js';
import type { SignalHub } from './hub.js';

const NOT_AVAILABLE = 'the phone camera is not available on this server yet';

type WebrtcMsg = SignalOf<'webrtc.offer'> | SignalOf<'webrtc.answer'> | SignalOf<'webrtc.ice'>;

/** `camera.hello { code } | { resumeKey }` (camera stream). The stub refuses and closes `4403`. */
export async function handleCameraHello(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.hello'>): Promise<void> {
  void hub;
  conn.error('forbidden', NOT_AVAILABLE, msg.id);
  conn.close(WS_CLOSE.forbidden, 'forbidden');
  return Promise.resolve();
}

/** `camera.ready` after the phone's track starts (camera stream; chains `camera.started`). */
export async function handleCameraReady(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.ready'>): Promise<void> {
  void hub;
  conn.error('forbidden', NOT_AVAILABLE, msg.id);
  return Promise.resolve();
}

/** `camera.stop { cameraId, reason }` from the phone (camera stream). */
export async function handleCameraStop(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.stop'>): Promise<void> {
  void hub;
  conn.error('forbidden', NOT_AVAILABLE, msg.id);
  return Promise.resolve();
}

/**
 * `webrtc.*` between the camera and the session's Assist (section 6.4): from the camera side to `live.assistConnId`
 * with `peer: 'camera'`; from the Assist with `peer: 'camera'` to `live.camera.connId`. Called by `handleWebrtc` only
 * after the sender was authorised for the session and the session is `active`.
 */
export async function routeCameraWebrtc(hub: SignalHub, conn: Conn, live: Live, msg: WebrtcMsg): Promise<void> {
  void hub;
  void live;
  conn.error('forbidden', NOT_AVAILABLE, msg.id);
  return Promise.resolve();
}

/**
 * `webrtc.*` between the camera and the session's joined A.2 recorder (section 6.5a): the camera's `peer: 'recorder'`
 * frames to the recorder socket, and the recorder's `peer: 'camera'` frames to the camera socket; nothing else.
 */
export async function routeCameraRecorderWebrtc(hub: SignalHub, conn: Conn, live: Live, msg: WebrtcMsg): Promise<void> {
  void hub;
  void live;
  conn.error('forbidden', NOT_AVAILABLE, msg.id);
  return Promise.resolve();
}
