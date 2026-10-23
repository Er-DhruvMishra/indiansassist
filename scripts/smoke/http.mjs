// Minimal REST client for the smoke test: JSON bodies, the CSRF header of section 6.1 on every non-GET request,
// and a one-cookie jar for `ia_session` (the signed cookie value is opaque to us; we echo it verbatim).

export class HttpError extends Error {
  constructor(method, path, status, body) {
    const code = body?.error?.code ? ` ${body.error.code}` : '';
    super(`${method} ${path} -> ${status}${code}`);
    this.status = status;
    this.body = body;
  }
}

export class ApiClient {
  /**
   * @param {string} apiUrl  origin of the api (or of nginx in production), e.g. http://localhost:4000
   * @param {{ origin?: string | null, fetchImpl?: typeof fetch }} [opts]
   *        origin: value of the Origin header (must equal WEB_ORIGIN when sent; omitted when null)
   */
  constructor(apiUrl, opts = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.origin = opts.origin ?? null;
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    this.cookie = null; // "ia_session=<value>"
  }

  cookieHeader() {
    return this.cookie;
  }

  async request(method, path, body) {
    const headers = { Accept: 'application/json, application/x-ndjson' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Requested-With'] = 'IndiansAssist';
    if (this.origin) headers.Origin = this.origin;
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await this.fetch(this.apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.#storeCookie(res.headers);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  /** Like request() but throws HttpError unless the status is one of `expected`. */
  async expect(method, path, body, expected = [200]) {
    const r = await this.request(method, path, body);
    if (!expected.includes(r.status)) throw new HttpError(method, path, r.status, r.json);
    return r.json;
  }

  #storeCookie(headers) {
    const list =
      typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
    for (const line of list) {
      const m = /^\s*ia_session=([^;]*)/.exec(line);
      if (!m) continue;
      const expired = /max-age=0/i.test(line) || m[1] === '';
      this.cookie = expired ? null : `ia_session=${m[1]}`;
    }
  }
}

/** http(s)://host -> ws(s)://host/signal (section 11.2: VITE_API_URL.replace(/^http/, 'ws') + '/signal'). */
export function signalUrlFor(apiUrl) {
  return apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/signal';
}
