/** Test doubles: WebSocket, RTCPeerConnection, media tracks, fetch responses. */
import { vi } from 'vitest';

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0;
  sent: string[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  /** Test helpers. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  messages(): { t: string; [k: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s) as { t: string });
  }
  ofType(t: string): { t: string; [k: string]: unknown }[] {
    return this.messages().filter((m) => m.t === t);
  }
}

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly label: string) {
    super();
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 'closed';
  }
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static reset(): void {
    FakePeerConnection.instances = [];
  }
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  channels: FakeChannel[] = [];
  tracks: MediaStreamTrack[] = [];
  closed = false;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  ontrack: (() => void) | null = null;
  ondatachannel: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  createDataChannel(label: string): FakeChannel {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    return ch;
  }
  addTrack(track: MediaStreamTrack): object {
    this.tracks.push(track);
    return { track };
  }
  removeTrack(): void {}
  async setLocalDescription(): Promise<void> {
    this.localDescription = { type: 'offer', sdp: 'v=0 fake' };
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  getConfiguration(): RTCConfiguration {
    return this.config;
  }
  setConfiguration(): void {}
  restartIce(): void {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {
    this.closed = true;
  }
}

export function fakeTrack(kind: 'video' | 'audio', surface = 'window') {
  const t = {
    kind,
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ displaySurface: surface }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return t as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

export function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const IDS = {
  org: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  token: '33333333-3333-4333-8333-333333333333',
  session: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
};

export const ISO = '2026-10-23T10:15:30.123Z';
export const LATER = '2026-10-23T23:59:59.000Z';
