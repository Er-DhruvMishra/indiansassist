/** A scripted WebSocket for the session machine tests: records sent frames, lets the test push server frames. */
export class FakeWS {
  static instances: FakeWS[] = [];
  static autoAck = true;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }

  static last(): FakeWS {
    return FakeWS.instances[FakeWS.instances.length - 1]!;
  }

  static reset(): void {
    FakeWS.instances = [];
    FakeWS.autoAck = true;
  }

  send(frame: string): void {
    const msg = JSON.parse(frame) as Record<string, unknown>;
    this.sent.push(msg);
    if (FakeWS.autoAck && msg.t === 'desk.event')
      queueMicrotask(() => this.recv({ t: 'event.ok', re: msg.id, sessionId: msg.sessionId, entryId: '00000000-0000-4000-8000-0000000000ee' }));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  recv(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  of(t: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.t === t);
  }
}
