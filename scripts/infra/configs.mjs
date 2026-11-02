// Static checks of the nginx and coturn configuration against contracts sections 11.4 and 11.5.
// Each function returns a list of problem strings; an empty list means PASS.

/** Contract 11.5 denied-peer-ip ranges, in contract order. */
export const DENIED_PEER_RANGES = [
  '0.0.0.0-0.255.255.255',
  '10.0.0.0-10.255.255.255',
  '100.64.0.0-100.127.255.255',
  '127.0.0.0-127.255.255.255',
  '169.254.0.0-169.254.255.255',
  '172.16.0.0-172.31.255.255',
  '192.0.0.0-192.0.0.255',
  '192.168.0.0-192.168.255.255',
  '198.18.0.0-198.19.255.255',
  '224.0.0.0-255.255.255.255',
  '::1',
  'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '::ffff:0:0-::ffff:ffff:ffff',
];

/** Flag-only and key=value directives that contract 11.5 requires. */
const TURN_FLAGS = [
  'use-auth-secret',
  'fingerprint',
  'no-tlsv1',
  'no-tlsv1_1',
  'no-cli',
  'no-multicast-peers',
  'no-rfc5780',
  'no-stun-backward-compatibility',
  'response-origin-only-with-rfc5780',
  'no-loopback-peers',
  'no-software-attribute',
  'secure-stun',
  'simple-log',
];
const TURN_VALUES = {
  'listening-port': '3478',
  'tls-listening-port': '5349',
  'static-auth-secret': '${TURN_SECRET}',
  realm: '${TURN_REALM}',
  'external-ip': '${TURN_EXTERNAL_IP}',
  'total-quota': '1200',
  'user-quota': '12',
  'max-bps': '0',
  'bps-capacity': '0',
  'stale-nonce': '600',
  'log-file': 'stdout',
  pidfile: '/var/tmp/turnserver.pid',
};

/** Active (uncommented) directives of a coturn config: [name, value | null][]. */
export function turnDirectives(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    out.push(i < 0 ? [line, null] : [line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

export function checkTurnserverConf(text) {
  const problems = [];
  const d = turnDirectives(text);
  const names = new Set(d.map(([k]) => k));
  const value = (k) => d.find(([n]) => n === k)?.[1];
  for (const f of TURN_FLAGS) if (!names.has(f)) problems.push(`turnserver.conf: missing ${f}`);
  for (const [k, v] of Object.entries(TURN_VALUES)) {
    if (value(k) !== v) problems.push(`turnserver.conf: ${k} must be ${v} (found ${value(k) ?? 'nothing'})`);
  }
  for (const k of ['min-port', 'max-port']) if (!value(k)) problems.push(`turnserver.conf: missing ${k}`);
  for (const k of ['cert', 'pkey']) if (!value(k)) problems.push(`turnserver.conf: missing ${k} (turns:5349)`);
  const denied = new Set(d.filter(([k]) => k === 'denied-peer-ip').map(([, v]) => v));
  for (const r of DENIED_PEER_RANGES) if (!denied.has(r)) problems.push(`turnserver.conf: missing denied-peer-ip=${r}`);
  if (names.has('allowed-peer-ip'))
    problems.push('turnserver.conf: allowed-peer-ip is set; only for a documented need');
  if (names.has('verbose') || names.has('Verbose')) problems.push('turnserver.conf: verbose must be off');
  if (names.has('no-auth') || names.has('lt-cred-mech'))
    problems.push('turnserver.conf: only use-auth-secret auth is allowed');
  if (/static-auth-secret=(?!\$\{TURN_SECRET\})/.test(text))
    problems.push('turnserver.conf: a literal static-auth-secret is present');
  return problems;
}

/** Contract 11.4 P3 headers, exact values. */
export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), display-capture=(self), microphone=(self)',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob: mediastream:; connect-src 'self' wss:; worker-src 'self' blob:; frame-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/** Phase B 10.2: `/replayer.html` header set (P3 minus X-Frame-Options, frame-ancestors of the host, CORP, no-store). */
export const REPLAYER_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), display-capture=(self), microphone=(self)',
  'Content-Security-Policy': 'frame-ancestors https://$host',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function checkReplayerLocation(webConf) {
  const block = locationBlock(webConf, '= /replayer.html');
  if (!block) return ['web.conf: missing location = /replayer.html (Phase B 10.2)'];
  const problems = [];
  for (const [h, v] of Object.entries(REPLAYER_HEADERS)) {
    const m = new RegExp(`add_header\\s+${h}\\s+"([^"]*)"\\s+always;`).exec(block);
    if (!m) problems.push(`web.conf: /replayer.html lacks add_header ${h} ... always`);
    else if (m[1] !== v) problems.push(`web.conf: /replayer.html ${h} is "${m[1]}", contract says "${v}"`);
  }
  if (/X-Frame-Options/.test(block)) problems.push('web.conf: /replayer.html must not send X-Frame-Options');
  if (/security-headers\.conf/.test(block))
    problems.push('web.conf: /replayer.html must not include the SPA header set');
  if (!/try_files\s+\$uri\s+=404;/.test(block))
    problems.push('web.conf: /replayer.html must be served as a file (try_files $uri =404)');
  return problems;
}

export function checkSecurityHeaders(text) {
  const problems = [];
  for (const [h, v] of Object.entries(SECURITY_HEADERS)) {
    const re = new RegExp(`^\\s*add_header\\s+${h}\\s+"([^"]*)"\\s+always;`, 'm');
    const m = re.exec(text);
    if (!m) problems.push(`security-headers.conf: missing add_header ${h} ... always`);
    else if (m[1] !== v) problems.push(`security-headers.conf: ${h} is "${m[1]}", contract says "${v}"`);
  }
  return problems;
}

/**
 * Phase B 13.5: the region list compiled into the extension must be the web app's list (the join handshake and
 * the bridge content script trust exactly these origins). Checks REGION_ORIGINS === VITE_REGION_ORIGINS (same
 * region=origin pairs) and that the production manifest generated from them lists each origin, and nothing else,
 * in `externally_connectable` and in the bridge content script's `matches`.
 * `buildManifest` is passed in (apps/extension/src/manifest.ts) so this module stays plain JS.
 */
export function checkRegionAgreement(env, buildManifest, version = '0.0.0') {
  const problems = [];
  const pairs = (k) =>
    String(env.get(k) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort();
  const api = pairs('REGION_ORIGINS');
  const web = pairs('VITE_REGION_ORIGINS');
  if (api.join(',') !== web.join(','))
    problems.push('REGION_ORIGINS and VITE_REGION_ORIGINS must list the same region=origin pairs');
  const origins = [...new Set(web.map((p) => p.slice(p.indexOf('=') + 1).replace(/\/+$/, '')))].sort();
  if (origins.length === 0) return [...problems, 'VITE_REGION_ORIGINS is empty'];
  const manifest = buildManifest({ version, regionOrigins: origins, devConnectSrc: [], key: null });
  const want = origins.map((o) => `${o}/*`).join(',');
  const ec = [...(manifest.externally_connectable?.matches ?? [])].sort().join(',');
  if (ec !== want)
    problems.push(`extension manifest externally_connectable (${ec}) does not equal the region origins (${want})`);
  for (const cs of manifest.content_scripts ?? []) {
    const m = [...cs.matches].sort().join(',');
    if (m !== want)
      problems.push(`extension manifest content script ${cs.js.join('+')} matches ${m}, expected ${want}`);
  }
  return problems;
}

/**
 * Phase F section 11 (W116): the only Permissions-Policy that allows the camera, sent by the phone page's two
 * locations (`= /c` and `^~ /c/`) and nowhere else.
 */
export const CAMERA_PERMISSIONS_POLICY = 'camera=(self), geolocation=(), display-capture=(), microphone=()';

/** Body of `location <spec> { ... }` with nested braces (e.g. `types { }`), or null. Last match wins. */
export function locationBlockNested(text, spec) {
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`location\\s+${esc}\\s*\\{`, 'g');
  let found = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    if (depth === 0) found = text.slice(start, i - 1);
  }
  return found;
}

const headerValue = (block, h) => new RegExp(`add_header\\s+${h}\\s+"([^"]*)"\\s+always;`).exec(block)?.[1];

/**
 * Phase F sections 4.4, 6.2e, 7.6e and 11 (W116): the phone-camera locations (the SPA header set with only the
 * camera Permissions-Policy, `/c/<code>` never logged), the service worker and manifest locations (no-cache, the SPA
 * header set, the manifest MIME type), the reset routes in the auth rate-limit location, and no other location
 * allowing the camera.
 */
export function checkPhaseFLocations(webConf) {
  const problems = [];
  for (const spec of ['= /c', '^~ /c/']) {
    const block = locationBlockNested(webConf, spec);
    if (!block) {
      problems.push(`web.conf: missing location ${spec} (Phase F 6.2e)`);
      continue;
    }
    for (const [h, v] of Object.entries(SECURITY_HEADERS)) {
      const want = h === 'Permissions-Policy' ? CAMERA_PERMISSIONS_POLICY : v;
      const got = headerValue(block, h);
      if (got === undefined) problems.push(`web.conf: ${spec} lacks add_header ${h} ... always`);
      else if (got !== want) problems.push(`web.conf: ${spec} ${h} is "${got}", contract says "${want}"`);
    }
    if (/security-headers\.conf/.test(block))
      problems.push(`web.conf: ${spec} must list its headers, not include the SPA set (camera=() would be sent too)`);
    if (!/try_files\s+\/index\.html\s+=404;/.test(block))
      problems.push(`web.conf: ${spec} must serve the SPA (try_files /index.html =404)`);
  }
  const codePath = locationBlockNested(webConf, '^~ /c/');
  if (codePath && !/access_log\s+off;/.test(codePath))
    problems.push('web.conf: ^~ /c/ must set access_log off (the camera code is in the path, Phase F 6.2e)');
  // No other place may allow the camera.
  const camAllowed = [...webConf.matchAll(/Permissions-Policy\s+"([^"]*)"/g)].filter((m) => /camera=\(self\)/.test(m[1]));
  if (camAllowed.length !== 2) {
    problems.push(`web.conf: camera=(self) must appear exactly twice (= /c and ^~ /c/), found ${camAllowed.length}`);
  }
  for (const spec of ['= /sw.js', '= /manifest.webmanifest']) {
    const block = locationBlockNested(webConf, spec);
    if (!block) {
      problems.push(`web.conf: missing location ${spec} (Phase F 7.6e)`);
      continue;
    }
    if (headerValue(block, 'Cache-Control') !== 'no-cache')
      problems.push(`web.conf: ${spec} must send Cache-Control "no-cache" always`);
    const includesSet = /include\s+\/etc\/nginx\/ia\/security-headers\.conf;/.test(block);
    const listsSet = Object.entries(SECURITY_HEADERS).every(([h, v]) => headerValue(block, h) === v);
    if (!includesSet && !listsSet) problems.push(`web.conf: ${spec} must repeat the full security header set`);
    if (/camera=\(self\)/.test(block)) problems.push(`web.conf: ${spec} must not allow the camera`);
    if (!/try_files\s+\$uri\s+=404;/.test(block)) problems.push(`web.conf: ${spec} must be served as a file`);
  }
  const manifest = locationBlockNested(webConf, '= /manifest.webmanifest');
  if (manifest && !/application\/manifest\+json/.test(manifest))
    problems.push('web.conf: /manifest.webmanifest must be served as application/manifest+json');
  const auth = /location\s+~\s+(\^\/api\/v1\/auth\/\S+)\s*\{/.exec(webConf)?.[1] ?? '';
  for (const route of ['login', 'password-reset/request', 'password-reset/confirm']) {
    if (!new RegExp(auth).test(`/api/v1/auth/${route}`))
      problems.push(`web.conf: the auth rate-limit location must match /api/v1/auth/${route} (Phase F 4.4)`);
  }
  if (auth && new RegExp(auth).test('/api/v1/auth/password-reset/other'))
    problems.push('web.conf: the auth rate-limit location matches more than the reset request and confirm routes');
  return problems;
}

/** Bodies of every `location <spec> { ... }` block (no nested blocks inside locations here). */
export function locationBlocks(text, spec) {
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`location\\s+${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

/** Body of the last `location <spec>` block (the 443 server follows the port 80 redirect server). */
export function locationBlock(text, spec) {
  return locationBlocks(text, spec).at(-1) ?? null;
}

export function checkNginx(mainConf, webConf, proxyCommon) {
  const problems = [];
  if (!/ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/.test(mainConf))
    problems.push('nginx.conf: ssl_protocols must be TLSv1.2 TLSv1.3 (P1)');
  if (!/ssl_prefer_server_ciphers\s+off;/.test(mainConf))
    problems.push('nginx.conf: ssl_prefer_server_ciphers off (P1)');
  const fmt = /log_format\s+\w+\s+'([^']*)'/.exec(mainConf)?.[1];
  if (fmt !== '$remote_addr - [$time_local] "$request_method $uri" $status $body_bytes_sent') {
    problems.push('nginx.conf: access log format must be the P4 format (path only)');
  }
  if (/\$request\b(?!_)|\$args|\$query_string|\$request_uri/.test(mainConf.replace(/^\s*#.*$/gm, ''))) {
    problems.push('nginx.conf: must not log $request, $args, $query_string or $request_uri (P4)');
  }
  if (!/client_max_body_size\s+1m;/.test(mainConf)) problems.push('nginx.conf: default client_max_body_size 1m (P5)');
  if (!/map\s+\$http_upgrade\s+\$connection_upgrade/.test(mainConf))
    problems.push('nginx.conf: missing $connection_upgrade map');

  if (!/upstream\s+ia_api\s*\{[^}]*server\s+api:4000;/.test(webConf))
    problems.push('web.conf: upstream must be api:4000');
  if (!/listen\s+443\s+ssl;/.test(webConf)) problems.push('web.conf: no TLS listener on 443');
  if (!/return\s+301\s+https:\/\/\$host\$request_uri;/.test(webConf))
    problems.push('web.conf: port 80 must redirect to https');
  if (!/include\s+\/etc\/nginx\/ia\/security-headers\.conf;/.test(webConf))
    problems.push('web.conf: security headers not included');

  const api = locationBlock(webConf, '/api/');
  if (!api || !/proxy_pass\s+http:\/\/ia_api;/.test(api))
    problems.push('web.conf: location /api/ must proxy to ia_api (P2)');
  const sig = locationBlock(webConf, '= /signal');
  if (!sig) problems.push('web.conf: missing location = /signal (P2)');
  else {
    if (!/proxy_set_header\s+Upgrade\s+\$http_upgrade;/.test(sig))
      problems.push('web.conf: /signal lacks the Upgrade header');
    if (!/proxy_set_header\s+Connection\s+\$connection_upgrade;/.test(sig))
      problems.push('web.conf: /signal lacks the Connection header');
    for (const k of ['proxy_read_timeout', 'proxy_send_timeout']) {
      const m = new RegExp(`${k}\\s+(\\d+)s;`).exec(sig);
      if (!m || Number(m[1]) !== 75)
        problems.push(`web.conf: /signal ${k} must be 75s (longer than the 60 s idle timeout)`);
    }
    if (!/proxy_pass\s+http:\/\/ia_api;/.test(sig)) problems.push('web.conf: /signal must proxy to ia_api');
  }
  const wk = locationBlock(webConf, '= /.well-known/indiansassist.json');
  if (!wk || !/proxy_pass\s+http:\/\/ia_api;/.test(wk))
    problems.push('web.conf: /.well-known/indiansassist.json must proxy to ia_api');
  const spa = locationBlock(webConf, '/');
  if (!spa || !/try_files\s+\$uri\s+\/index\.html;/.test(spa))
    problems.push('web.conf: SPA fallback try_files $uri /index.html');
  if (/location[^{]*metrics/.test(webConf) || /9464/.test(webConf))
    problems.push('web.conf: /metrics must never be proxied');

  const rec = /location\s+~\s+\^\/api\/v1\/sessions\/\[\^\/\]\+\/recordings\$\s*\{([^}]*)\}/.exec(webConf)?.[1];
  if (!rec || !/client_max_body_size\s+110m;/.test(rec))
    problems.push('web.conf: recordings upload needs client_max_body_size 110m (P5)');
  const parts = /location\s+~\s+\^\/api\/v1\/recordings\/uploads\/[^{]*parts[^{]*\{([^}]*)\}/.exec(webConf)?.[1];
  if (!parts || !/client_max_body_size\s+17m;/.test(parts))
    problems.push('web.conf: upload parts need client_max_body_size 17m (P5)');

  if (!/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/.test(proxyCommon)) {
    problems.push('proxy-common.conf: X-Forwarded-For must be overwritten with $remote_addr (TRUST_PROXY keying)');
  }
  if (!/proxy_http_version\s+1\.1;/.test(proxyCommon)) problems.push('proxy-common.conf: proxy_http_version 1.1');
  return problems;
}
