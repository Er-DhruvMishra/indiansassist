/** Shared ICE server entries -> the plain `{ urls, username?, credential? }` objects the offscreen PC takes. */
export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export function toRtcIceServers(servers: readonly { urls: string | string[]; username?: string; credential?: string }[]): IceServer[] {
  return servers.map((s) => {
    const out: IceServer = { urls: s.urls };
    if (s.username !== undefined) out.username = s.username;
    if (s.credential !== undefined) out.credential = s.credential;
    return out;
  });
}
