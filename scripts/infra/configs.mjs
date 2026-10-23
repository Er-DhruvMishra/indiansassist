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
    "media-src 'self' blob: mediastream:; connect-src 'self' wss:; worker-src 'self' blob:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

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
