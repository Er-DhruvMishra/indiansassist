#!/usr/bin/env node
/**
 * Licence-register cross-check (Phase C contract §16.1 last bullet, §15.5 gates).
 *
 * Reads docs/LICENSE-REGISTER.md and the project's real dependency declarations and reports two kinds of drift:
 *   - a dependency that is present in the build but has no row in the register ("missing");
 *   - a register row whose named component is no longer a dependency of any build ("stale").
 *
 * Dependency sources:
 *   - npm    : the runtime dependencies (dependencies / optionalDependencies / peerDependencies, not
 *              devDependencies) of every workspace package.json; internal @indiansassist/* packages are skipped.
 *   - cargo  : the agent workspace's direct dependencies, read from `cargo metadata --format-version 1
 *              --manifest-path agent/Cargo.toml` (workspace members' `dependencies`). If cargo cannot be run,
 *              it falls back to the workspace manifests (agent/Cargo.toml + agent/crates/<c>/Cargo.toml).
 *              The full resolved crate set (for the stale check) comes from the same cargo metadata, falling
 *              back to agent/Cargo.lock.
 *   - gradle : best-effort, the `group:artifact:version` coordinates declared in apps/android/build.gradle.kts.
 *
 * The register is free text (components are grouped and annotated), so coverage is matched leniently:
 * a dependency counts as registered when its name (as written, with -/_/ /. folded, or squished to
 * alphanumerics, or a scoped @scope/ prefix) appears anywhere in the register. The stale check only
 * considers rows whose Status marks them as actively used (not service / build-only / planned / dev /
 * reference / not-used / forbidden rows, which legitimately name non-dependencies).
 *
 * Read-only. Exits non-zero when any mismatch is found. Usage: `node scripts/license-check.mjs [--json]`.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const r = (...p) => resolve(root, ...p);

// --- the register -----------------------------------------------------------
const registerPath = r('docs/LICENSE-REGISTER.md');
if (!existsSync(registerPath)) {
  console.error(`license-check: ${registerPath} not found`);
  process.exit(2);
}
const registerRaw = readFileSync(registerPath, 'utf8');

/** Table rows as { component, status } (the first and last cells of a | component | licence | use | status | row). */
function parseRegisterRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells.every((c) => /^-+:?$/.test(c) || c === '')) continue; // separator row
    const component = cells[0].replace(/\*\*/g, '').trim();
    const status = (cells[cells.length - 1] || '').toLowerCase();
    if (!component || /^component$/i.test(component)) continue; // header
    rows.push({ component, status });
  }
  return rows;
}
const registerRows = parseRegisterRows(registerRaw);
const registerLower = registerRaw.toLowerCase();
const registerSpaced = ` ${registerLower.replace(/[^a-z0-9]+/g, ' ')} `;
const registerSquished = registerLower.replace(/[^a-z0-9]+/g, '');

/** True when a dependency id is named somewhere in the register (lenient). */
function isRegistered(id) {
  const d = id.toLowerCase();
  if (registerLower.includes(d)) return true;
  if (d.startsWith('@')) {
    const scope = d.slice(0, d.indexOf('/') + 1); // "@fastify/"
    if (scope.length > 1 && registerLower.includes(scope)) return true;
  }
  const spaced = d.replace(/[@/]/g, ' ').replace(/[-_.]/g, ' ').trim();
  if (spaced && registerSpaced.includes(` ${spaced} `)) return true;
  const squished = d.replace(/[^a-z0-9]+/g, '');
  if (squished && registerSquished.includes(squished)) return true;
  return false;
}

// --- npm ---------------------------------------------------------------------
function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function npmDeps() {
  const manifests = [r('package.json')];
  for (const d of ['apps', 'packages']) {
    const base = r(d);
    if (!existsSync(base)) continue;
    for (const name of readdirSafe(base)) {
      const p = resolve(base, name, 'package.json');
      if (existsSync(p)) manifests.push(p);
    }
  }
  const runtime = new Set();
  const all = new Set();
  for (const p of manifests) {
    const pkg = readJson(p);
    if (!pkg) continue;
    for (const k of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (!k.startsWith('@indiansassist/')) runtime.add(k);
    }
    for (const k of Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    })) {
      if (!k.startsWith('@indiansassist/')) all.add(k);
    }
  }
  return { runtime: [...runtime].sort(), all };
}
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// --- cargo -------------------------------------------------------------------
function cargoMetadata() {
  const cargo = process.env.CARGO || 'cargo';
  const res = spawnSync(cargo, ['metadata', '--format-version', '1', '--manifest-path', r('agent/Cargo.toml')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: Number(process.env.IA_CARGO_TIMEOUT_MS || 300_000),
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}
function parseCargoManifestsDirect() {
  const files = [r('agent/Cargo.toml')];
  const cratesDir = r('agent/crates');
  if (existsSync(cratesDir)) for (const c of readdirSafe(cratesDir)) files.push(resolve(cratesDir, c, 'Cargo.toml'));
  const names = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    let inDeps = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      const sec = t.match(/^\[(.+)\]$/);
      if (sec) {
        inDeps =
          /(^|[. ])dependencies$/.test(sec[1]) ||
          /^workspace\.dependencies$/.test(sec[1]) ||
          /dependencies$/.test(sec[1]);
        continue;
      }
      if (!inDeps || !t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Za-z0-9_-]+)(\.workspace)?\s*=/);
      if (m) names.add(m[1]);
    }
  }
  for (const n of [...names]) if (/^ia-/.test(n)) names.delete(n);
  return names;
}
function cargoDeps() {
  const meta = cargoMetadata();
  if (meta) {
    const members = new Set(meta.workspace_members || []);
    const byId = new Map((meta.packages || []).map((p) => [p.id, p]));
    const internal = new Set();
    const direct = new Set();
    const all = new Set();
    for (const p of meta.packages || []) all.add(p.name);
    for (const id of members) {
      const p = byId.get(id);
      if (!p) continue;
      internal.add(p.name);
    }
    for (const id of members) {
      const p = byId.get(id);
      if (!p) continue;
      for (const dep of p.dependencies || []) {
        if (dep.kind === 'dev') continue; // test-only, not shipped / not register-tracked
        if (!internal.has(dep.name)) direct.add(dep.name);
      }
    }
    for (const n of internal) all.delete(n);
    return { direct: [...direct].sort(), all, source: 'cargo metadata' };
  }
  // fallback: manifests for direct, Cargo.lock for the full set
  const direct = parseCargoManifestsDirect();
  const all = new Set();
  const lock = r('agent/Cargo.lock');
  if (existsSync(lock)) {
    for (const m of readFileSync(lock, 'utf8').matchAll(/^name = "([^"]+)"/gm)) all.add(m[1]);
  }
  for (const n of [...all]) if (/^ia-/.test(n)) all.delete(n);
  return {
    direct: [...direct].sort(),
    all,
    source: existsSync(lock) ? 'Cargo.lock (cargo unavailable)' : 'manifests (cargo + lock unavailable)',
  };
}

// --- gradle (best-effort) ----------------------------------------------------
function gradleDeps() {
  const f = r('apps/android/build.gradle.kts');
  const coords = new Set();
  if (!existsSync(f)) return { coords: [], present: false };
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(
    /(?:implementation|api|testImplementation|androidTestImplementation|compileOnly|runtimeOnly)\s*\(\s*"([^":]+:[^":]+):[^"]*"\s*\)/g,
  )) {
    coords.add(m[1]); // group:artifact
  }
  return { coords: [...coords].sort(), present: true };
}

// --- run ---------------------------------------------------------------------
const npm = npmDeps();
const cargo = cargoDeps();
const gradle = gradleDeps();

const missing = { npm: [], cargo: [], gradle: [] };
for (const d of npm.runtime) if (!isRegistered(d)) missing.npm.push(d);
for (const d of cargo.direct) if (!isRegistered(d)) missing.cargo.push(d);
for (const c of gradle.coords) {
  const [, artifact] = c.split(':');
  if (!isRegistered(artifact) && !isRegistered(c)) missing.gradle.push(c);
}

// Build set for staleness: every dependency identifier the build actually uses.
const buildIds = new Set();
for (const s of [npm.all, new Set(npm.runtime), cargo.all, new Set(cargo.direct)])
  for (const x of s) buildIds.add(x.toLowerCase());
for (const c of gradle.coords) {
  buildIds.add(c.toLowerCase());
  const [group, artifact] = c.split(':');
  buildIds.add(group.toLowerCase());
  buildIds.add(artifact.toLowerCase());
}
const buildSpaced = ` ${[...buildIds].join(' ').replace(/[^a-z0-9]+/g, ' ')} `;
const buildSquished = new Set([...buildIds].map((x) => x.replace(/[^a-z0-9]+/g, '')));

const STALE_SKIP =
  /(self-hosted|service|build only|build-only|build image|runtime image|\bimage\b|planned|reference|not used|forbidden|\(dev\)|\bdev\b)/;
/** Extract package-like identifiers from a register component cell. */
function componentIds(component) {
  const ids = new Set();
  for (const m of component.matchAll(/`([^`]+)`/g)) ids.add(m[1]); // `agent/`, `winapi`
  for (const m of component.matchAll(/@[a-z0-9-]+\/[a-z0-9._-]+/gi)) ids.add(m[0]); // @rrweb/types
  for (const m of component.matchAll(/[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-z0-9]+(?:[._-][a-z0-9]+)*/gi)) ids.add(m[0]); // group:artifact
  for (const m of component.matchAll(/\b[a-z][a-z0-9]+(?:[-_][a-z0-9]+)+\b/g)) ids.add(m[0]); // prom-client, windows-rs
  for (const m of component.matchAll(/\(([^)]*)\)/g))
    for (const tok of m[1].split(/[,\s]+/)) if (/^[a-z][a-z0-9._/-]+$/i.test(tok) && tok.length >= 2) ids.add(tok); // (pg)
  const lead = component
    .replace(/[*`]/g, '')
    .trim()
    .match(/^([@a-z0-9][a-z0-9._/-]+)/i); // leading package token
  if (lead) ids.add(lead[1]);
  return [...ids].map((x) => x.toLowerCase().replace(/[.,;()]+$/, '')).filter(Boolean);
}
function idInBuild(id) {
  if (buildIds.has(id)) return true;
  if (id.includes(':')) {
    const [g, a] = id.split(':');
    if (buildIds.has(g) || buildIds.has(a)) return true;
  }
  const spaced = id
    .replace(/[@/]/g, ' ')
    .replace(/[-_.:]/g, ' ')
    .trim();
  if (spaced && buildSpaced.includes(` ${spaced} `)) return true;
  const squished = id.replace(/[^a-z0-9]+/g, '');
  if (squished && buildSquished.has(squished)) return true;
  return false;
}
const stale = [];
for (const row of registerRows) {
  if (!row.status) continue; // section sub-header rows (empty licence/use/status)
  if (STALE_SKIP.test(row.status)) continue;
  const ids = componentIds(row.component);
  if (ids.length === 0) continue; // nothing package-like to verify
  if (ids.some(idInBuild)) continue;
  // Go modules and other unscanned ecosystems use slash-paths without an npm @scope; skip rather than false-flag.
  const pathLike = ids.some((i) => i.includes('/') && !i.startsWith('@'));
  if (pathLike) continue;
  stale.push({ component: row.component, status: row.status, ids });
}

const findings = {
  cargoSource: cargo.source,
  gradlePresent: gradle.present,
  counts: { npmRuntime: npm.runtime.length, cargoDirect: cargo.direct.length, gradleCoords: gradle.coords.length },
  missing,
  stale,
};

if (asJson) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  console.log(
    `license-check: npm runtime ${npm.runtime.length}, cargo direct ${cargo.direct.length} (${cargo.source}), gradle ${gradle.coords.length}`,
  );
  const printMissing = (label, list) => {
    if (list.length) {
      console.log(`\nMissing from docs/LICENSE-REGISTER.md (${label}): ${list.length}`);
      for (const d of list) console.log(`  - ${d}`);
    }
  };
  printMissing('npm runtime', missing.npm);
  printMissing('cargo direct', missing.cargo);
  printMissing('gradle', missing.gradle);
  if (stale.length) {
    console.log(`\nRegister rows with no matching dependency (stale): ${stale.length}`);
    for (const s of stale) console.log(`  - ${s.component}  [status: ${s.status}]`);
  }
  const total = missing.npm.length + missing.cargo.length + missing.gradle.length + stale.length;
  console.log(total === 0 ? '\nOK: register and dependencies agree.' : `\nFAIL: ${total} mismatch(es).`);
}

const total = missing.npm.length + missing.cargo.length + missing.gradle.length + stale.length;
process.exit(total === 0 ? 0 : 1);
