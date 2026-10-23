/**
 * Voice in the offscreen document (section 7 "Voice"): muted by default (A D8). The side panel obtains the
 * microphone grant first (an offscreen document cannot show a permission prompt); afterwards this document takes
 * its own track for the extension origin without a prompt. Remote audio plays through an `<audio>` element.
 */
export class Voice {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private sender: RTCRtpSender | null = null;
  private audio: HTMLAudioElement | null = null;
  muted = true;

  async setMuted(muted: boolean, addTrack: (t: MediaStreamTrack, s: MediaStream) => RTCRtpSender | null): Promise<void> {
    this.muted = muted;
    if (!muted && !this.track) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.track = this.stream.getAudioTracks()[0] ?? null;
        if (this.track) this.sender = addTrack(this.track, this.stream);
      } catch {
        this.muted = true;
        return;
      }
    }
    if (this.track) this.track.enabled = !this.muted;
  }

  /** After a peer-connection rebuild the existing track is added to the new connection. */
  reattach(addTrack: (t: MediaStreamTrack, s: MediaStream) => RTCRtpSender | null): void {
    if (this.track && this.stream) this.sender = addTrack(this.track, this.stream);
  }

  playRemote(track: MediaStreamTrack): void {
    if (track.kind !== 'audio') return;
    if (!this.audio) {
      this.audio = document.createElement('audio');
      this.audio.autoplay = true;
      document.body.appendChild(this.audio);
    }
    this.audio.srcObject = new MediaStream([track]);
    void this.audio.play().catch(() => undefined);
  }

  stop(): void {
    this.track?.stop();
    this.track = null;
    this.stream = null;
    this.sender = null;
    this.muted = true;
    if (this.audio) {
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }
}
