// Run inside the container by smoke.sh (as root, to read /proc/<pid>/fd). Reads /proc only and needs no extra package.
// Prints addresses, process names and setting names, never a value of a secret. Exits 1 on any violation.

import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `/proc/net/*` local address -> { addr, port }. IPv4 is one little-endian word, IPv6 four. */
export function parseLocal(hex) {
  const [a, p] = hex.split(':');
  const port = parseInt(p, 16);
  if (a.length === 8) return { addr: a.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.'), port };
  const groups = [];
  for (let i = 0; i < 32; i += 8) {
    const word = a.slice(i, i + 8).match(/../g).reverse().join('');
    groups.push(word.slice(0, 4), word.slice(4));
  }
  return { addr: groups.map((g) => g.toLowerCase()).join(':'), port };
}

export function isLoopback(addr) {
  if (/^127\./.test(addr)) return true;
  if (addr === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  const m = /^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):[0-9a-f]{4}$/.exec(addr);
  return m !== null && m[1].startsWith('7f');
}

/** Every listening TCP socket and bound UDP socket: { proto, addr, port, inode }. */
export function sockets(read = (p) => readFileSync(p, 'utf8')) {
  const out = [];
  for (const [file, proto, listenState] of [
    ['/proc/net/tcp', 'tcp', '0A'],
    ['/proc/net/tcp6', 'tcp6', '0A'],
    ['/proc/net/udp', 'udp', '07'],
    ['/proc/net/udp6', 'udp6', '07'],
  ]) {
    let text = '';
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== listenState) continue;
      out.push({ proto, ...parseLocal(f[1]), inode: f[9] });
    }
  }
  return out;
}

/** A root process is acceptable only if it must be root: PID 1, the supervisor tree, or the nginx master. */
export function rootAllowed(cmdline) {
  return /entrypoint\.sh|^runsvdir|^runsv |^nginx: master/.test(cmdline);
}

const pids = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d));
const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const cmdlineOf = (pid) => safe(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replace(/\0/g, ' '), '');
const commOf = (pid) => safe(() => readFileSync(`/proc/${pid}/comm`, 'utf8').trim(), '');
const uidOf = (pid) => safe(() => Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]), -1);

function inodeOwners() {
  const owners = new Map();
  for (const pid of pids()) {
    for (const fd of safe(() => readdirSync(`/proc/${pid}/fd`), [])) {
      const m = /^socket:\[(\d+)\]$/.exec(safe(() => readlinkSync(`/proc/${pid}/fd/${fd}`), ''));
      if (m) owners.set(m[1], commOf(pid));
    }
  }
  return owners;
}

function checkSockets(problems) {
  const owners = inodeOwners();
  const all = sockets();
  for (const s of all) {
    const comm = owners.get(s.inode) ?? '';
    if (isLoopback(s.addr)) continue;
    console.log(`public ${s.proto} ${s.addr}:${s.port} ${comm}`);
    if (comm !== 'nginx' && comm !== 'turnserver') problems.push(`${comm || 'unknown'} listens on ${s.addr}:${s.port}`);
  }
  for (const [name, port] of [
    ['postgres', 15432],
    ['valkey', 16379],
    ['s3', 18333],
    ['api', 14000],
    ['metrics', 19464],
  ]) {
    const found = all.filter((s) => s.port === port && s.proto.startsWith('tcp'));
    if (found.length === 0) problems.push(`${name}: nothing listens on ${port}`);
    for (const s of found) if (!isLoopback(s.addr)) problems.push(`${name}: bound to ${s.addr}, expected loopback`);
  }
}

async function checkRootProcesses(problems) {
  // A process seen once may be a transient (the healthcheck, a finish script): only one that persists is a finding.
  let suspects = null;
  for (let pass = 0; pass < 4; pass++) {
    const now = new Set();
    for (const pid of pids()) {
      if (Number(pid) === process.pid || uidOf(pid) !== 0) continue;
      const cmd = cmdlineOf(pid);
      if (cmd !== '' && !rootAllowed(cmd)) now.add(`${pid} ${commOf(pid)}`);
    }
    suspects = suspects === null ? now : new Set([...suspects].filter((s) => now.has(s)));
    if (suspects.size === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  for (const s of suspects) problems.push(`runs as root without needing to: ${s}`);
  const masters = pids().filter((p) => uidOf(p) === 0 && /^nginx: master/.test(cmdlineOf(p)));
  if (masters.length !== 1) problems.push(`expected one root nginx master, found ${masters.length}`);
}

function userIds() {
  return new Map(readFileSync('/etc/passwd', 'utf8').split('\n').filter(Boolean).map((l) => [Number(l.split(':')[2]), l.split(':')[0]]));
}

function checkServiceUsers(problems) {
  const names = userIds();
  const expected = [
    [/^postgres -D/, 'postgres'],
    [/^valkey-server/, 'valkey'],
    [/^weed server/, 'seaweedfs'],
    [/^node dist\/server\.js/, 'ia-api'],
    [/^turnserver/, 'turnserver'],
    [/^nginx: worker/, 'nginx'],
  ];
  for (const [re, user] of expected) {
    const matching = pids().filter((p) => re.test(cmdlineOf(p)));
    if (matching.length === 0) problems.push(`no process matches ${re}`);
    for (const p of matching) if (names.get(uidOf(p)) !== user) problems.push(`${re} runs as ${names.get(uidOf(p))}, expected ${user}`);
  }
}

function checkApiEnvironment(problems) {
  const pid = pids().find((p) => /^node dist\/server\.js/.test(cmdlineOf(p)));
  if (!pid) {
    problems.push('the api process was not found');
    return;
  }
  const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
  const get = (k) => entries.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
  if (get('POSTGRES_OWNER_PASSWORD') !== undefined) problems.push('the api environment holds POSTGRES_OWNER_PASSWORD');
  if (get('MIGRATE_DATABASE_URL')) problems.push('the api environment holds a non-empty MIGRATE_DATABASE_URL');
  if (!/^postgres:\/\/ia_app:/.test(get('DATABASE_URL') ?? '')) problems.push('the api does not connect as ia_app');
  if (get('IA_DOMAIN') !== undefined) problems.push('the container environment leaked into the api');
}

function checkFileModes(problems) {
  const modeOf = (p) => safe(() => (statSync(p).mode & 0o777).toString(8), 'missing');
  if (modeOf('/data/secrets/ia.env') !== '600') problems.push(`/data/secrets/ia.env has mode ${modeOf('/data/secrets/ia.env')}`);
  if (modeOf('/data/secrets') !== '700') problems.push('/data/secrets must be mode 700');
  for (const f of readdirSync('/run/ia/env')) if (modeOf(`/run/ia/env/${f}`) !== '600') problems.push(`/run/ia/env/${f} is not mode 600`);
  if (readdirSync('/run/ia/env').includes('pg-init.env')) problems.push('pg-init.env must be gone after first boot');
}

async function main() {
  const problems = [];
  checkSockets(problems);
  await checkRootProcesses(problems);
  checkServiceUsers(problems);
  checkApiEnvironment(problems);
  checkFileModes(problems);
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL  ${p}`);
    process.exit(1);
  }
  console.log('inside checks passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
