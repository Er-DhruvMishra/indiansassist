// Static checks of infra/allinone and .github/workflows/docker.yml (Docker is not needed). Every check returns a list
// of problem strings; an empty list means PASS.

import YAML from 'yaml';
import { CONTRACT_SERVICES } from './compose.mjs';

/** Scripts copied into the image; a CRLF line ending or a wrong shebang would stop the container from starting. */
export const ALLINONE_SCRIPTS = [
  'infra/allinone/entrypoint.sh',
  'infra/allinone/service.sh',
  'infra/allinone/finish.sh',
  'infra/allinone/pg-init.sh',
  'infra/allinone/certs.sh',
  'infra/allinone/healthcheck.sh',
  'infra/allinone/lib.sh',
  'infra/allinone/smoke.sh',
  'infra/seaweedfs/entrypoint.sh',
  'infra/seaweedfs/create-bucket.sh',
  'infra/coturn/entrypoint.sh',
  'infra/postgres/init/01-roles.sh',
  'infra/scripts/init-env.sh',
  'infra/nginx/10-ia-selfsigned-cert.sh',
];

export function checkScriptText(name, text) {
  const problems = [];
  if (text.includes('\r')) problems.push(`${name}: contains a carriage return (CRLF breaks the shebang in the image)`);
  if (!/^#!\/(bin\/bash|bin\/sh|usr\/bin\/env bash)\n/.test(text)) problems.push(`${name}: must start with a bash or POSIX sh shebang`);
  return problems;
}

/** Files the image takes from the Compose stack instead of forking them. */
const REUSED_FILES = [
  'infra/api/migrate.mjs',
  'infra/nginx/nginx.conf',
  'infra/nginx/security-headers.conf',
  'infra/nginx/web.conf',
  'infra/nginx/proxy-common.conf',
  'infra/nginx/10-ia-selfsigned-cert.sh',
  'infra/coturn/turnserver.conf',
  'infra/coturn/entrypoint.sh',
  'infra/seaweedfs/entrypoint.sh',
  'infra/seaweedfs/create-bucket.sh',
  'infra/postgres/init/01-roles.sh',
  'infra/scripts/init-env.sh',
  'infra/.env.example',
];

const stripDockerComments = (t) => t.replace(/^\s*#.*$/gm, '');

/** The Dockerfile: pinned sources matching Compose, reused files, no domain, no secret, the required end state. */
export function checkAllinoneDockerfile(text, apiDockerfile) {
  const problems = [];
  const code = stripDockerComments(text);

  const argOf = (name) => new RegExp(`^ARG ${name}=(\\S+)`, 'm').exec(code)?.[1];
  const seaweed = CONTRACT_SERVICES.seaweedfs.image;
  if (argOf('SEAWEEDFS_IMAGE') !== seaweed) problems.push(`Dockerfile: SeaweedFS must be ${seaweed}, the Compose version`);
  if (!/^valkey\/valkey:8-/.test(argOf('VALKEY_IMAGE') ?? '')) problems.push('Dockerfile: Valkey must be major 8, the Compose version');
  if (argOf('PG_MAJOR') !== '16') problems.push('Dockerfile: Postgres must be major 16, the Compose version');
  if (!/^nginx:1\.27-/.test(argOf('NGINX_IMAGE') ?? '')) problems.push('Dockerfile: nginx must be 1.27, the version web.conf is written for');
  if (/^FROM\s+\S+:latest\b/m.test(code) || /_IMAGE=\S+:latest\b/.test(code)) problems.push('Dockerfile: no image may float on :latest');

  // The build stages cannot be shared with apps/api/Dockerfile, so they must stay the same.
  const apiArg = (name) => new RegExp(`^ARG ${name}=(\\S+)`, 'm').exec(stripDockerComments(apiDockerfile))?.[1];
  for (const name of ['NODE_IMAGE', 'PNPM_VERSION']) {
    if (argOf(name) !== apiArg(name)) problems.push(`Dockerfile: ${name} differs from apps/api/Dockerfile`);
  }
  for (const m of stripDockerComments(apiDockerfile).matchAll(/^COPY --from=build\s+\S*\s*(\/app\/\S+)/gm)) {
    if (!code.includes(`COPY --from=build ${m[1]}`)) problems.push(`Dockerfile: apps/api/Dockerfile copies ${m[1]} but this image does not`);
  }

  for (const f of REUSED_FILES) if (!code.includes(f)) problems.push(`Dockerfile: must reuse ${f}`);

  if (/VITE_API_URL=|VITE_REGION_ORIGINS=|--build-arg/.test(code)) problems.push('Dockerfile: no domain may be compiled into the bundle');
  if (/^(ENV|ARG)\s.*(PASSWORD|SECRET|SIGNING_KEY)/im.test(code)) problems.push('Dockerfile: no secret may be set in the image');
  if (/^USER\s/m.test(code)) problems.push('Dockerfile: the entrypoint starts as root and drops per service; no USER');
  if (!/^VOLUME \/data$/m.test(code)) problems.push('Dockerfile: one data volume at /data');
  if (!/^HEALTHCHECK\s/m.test(code)) problems.push('Dockerfile: HEALTHCHECK is required');
  if (!/^ENTRYPOINT \["\/ia\/bin\/entrypoint\.sh"\]$/m.test(code)) problems.push('Dockerfile: ENTRYPOINT must be the supervising entrypoint');
  if (!/B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8/.test(code)) problems.push('Dockerfile: the PGDG key must be checked against its fingerprint');
  // The postinst of the postgresql and coturn packages runs `adduser --system`, which rejects a user outside 100-999.
  const ids = [...code.matchAll(/\b(postgres|turnserver):(\d+)\b/g)];
  if (ids.length < 2) problems.push('Dockerfile: postgres and turnserver need fixed ids');
  for (const [, name, id] of ids) {
    if (Number(id) < 100 || Number(id) > 999) problems.push(`Dockerfile: ${name} id ${id} is outside Debian's system range (100-999)`);
  }
  if (!/ln -sf \/run\/ia\/web\/runtime-config\.js/.test(code)) problems.push('Dockerfile: runtime-config.js must point at the file written at start');
  if (/\bsupervisor\b/.test(code)) problems.push('Dockerfile: supervisor is not OSI-licensed as written (docs/LICENSE-REGISTER.md); use runit');
  return problems;
}

/** The scripts that enforce the security properties of infra/HARDENING.md. */
export function checkAllinoneRuntime({ entrypoint, service, render }) {
  const problems = [];
  if (!/env -i PATH="\$PATH" runsvdir/.test(entrypoint)) problems.push('entrypoint: runit must start with a clean environment (env -i)');
  if (!/PG_VERSION[\s\S]*Refusing to generate new keys/.test(entrypoint)) problems.push('entrypoint: must refuse to regenerate keys when a database exists');
  if (!/ENV_FILE="\$SECRETS" sh \/ia\/infra\/scripts\/init-env\.sh/.test(entrypoint)) problems.push('entrypoint: secrets must come from init-env.sh');
  if (/FORCE=1/.test(entrypoint)) problems.push('entrypoint: must never pass FORCE=1 to init-env.sh');
  if (/set -x/.test(entrypoint + service)) problems.push('scripts: set -x would print secrets to the log');
  const order = ['nginx" "$SV/coturn', '$SV/api', '$SV/valkey', '$SV/postgres'].map((s) => entrypoint.indexOf(s));
  if (order.some((i) => i < 0) || order.some((v, i) => i > 0 && v < order[i - 1])) problems.push('entrypoint: stop order must be edge, api, stores, Postgres last');

  for (const [svc, user] of [['postgres', 'postgres'], ['valkey', 'valkey'], ['seaweedfs', 'seaweedfs'], ['coturn', 'turnserver']]) {
    const block = new RegExp(`^\\s*${svc}\\)[\\s\\S]*?;;`, 'm').exec(service)?.[0] ?? '';
    if (!new RegExp(`as_user ${user}\\b`).test(block)) problems.push(`service.sh: ${svc} must run as ${user}`);
  }
  const api = /^\s*api\)[\s\S]*?;;/m.exec(service)?.[0] ?? '';
  if (!/as_user ia-api node dist\/server\.js/.test(api)) problems.push('service.sh: the api must run as ia-api');
  if (!/as_user ia-migrate node ia-migrate\.mjs/.test(api)) problems.push('service.sh: migrations must run as ia-migrate');
  const migrateAt = api.indexOf('ia-migrate.mjs');
  const apiAt = api.indexOf('as_user ia-api');
  if (migrateAt < 0 || migrateAt > apiAt) problems.push('service.sh: migrations must finish before the api starts');
  if (!/\(\s*load_env migrate;/.test(api)) problems.push('service.sh: the owner credential must stay in a subshell');
  if (!/MIGRATE_DATABASE_URL: ''/.test(render)) problems.push('render.mjs: the api must get an empty MIGRATE_DATABASE_URL');
  if (!/HOST: '127\.0\.0\.1'/.test(render)) problems.push('render.mjs: the api and its metrics must listen on loopback');
  if (!/bind 127\.0\.0\.1/.test(render)) problems.push('render.mjs: Valkey must listen on loopback');
  if (!/SEAWEED_BIND_IP: '127\.0\.0\.1'/.test(render)) problems.push('render.mjs: SeaweedFS must listen on loopback');
  if (!/listen_addresses=127\.0\.0\.1/.test(service)) problems.push('service.sh: Postgres must listen on loopback');
  return problems;
}

/** The workflow: triggers, pinning, least privilege, and no publish without a passing smoke. */
export function checkDockerWorkflow(text) {
  const problems = [];
  const wf = YAML.parse(text);
  const on = wf.on ?? wf[true];
  if (!on?.push?.branches?.includes('master')) problems.push('docker.yml: must run on pushes to master');
  if (!on?.push?.tags?.includes('v*')) problems.push('docker.yml: must run on v* tags');
  if (!Array.isArray(on?.push?.paths) || on.push.paths.length === 0) problems.push('docker.yml: a push to master must be limited to relevant paths');
  if (!('workflow_dispatch' in (on ?? {}))) problems.push('docker.yml: must allow workflow_dispatch');
  if (wf.permissions?.packages !== undefined) problems.push('docker.yml: packages: write belongs on the publish job only');

  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(raw);
    if (!m) continue;
    if (!/@[0-9a-f]{40}$/.test(m[1])) problems.push(`docker.yml: ${m[1]} is not pinned to a full commit SHA`);
    if (!/#\s*v\d/.test(m[2])) problems.push(`docker.yml: ${m[1]} lacks its version comment`);
  }

  const jobs = wf.jobs ?? {};
  const smoke = jobs['build-smoke'];
  const publish = jobs.publish;
  if (!smoke || !publish) return [...problems, 'docker.yml: jobs build-smoke and publish are required'];
  if (publish.needs !== 'build-smoke') problems.push('docker.yml: publish must need build-smoke');
  if (publish.permissions?.packages !== 'write') problems.push('docker.yml: publish needs packages: write');
  if (smoke.permissions?.packages !== undefined) problems.push('docker.yml: build-smoke must not hold packages: write');
  if (!/refs\/tags\/v/.test(publish.if ?? '') || !/workflow_dispatch/.test(publish.if ?? '')) problems.push('docker.yml: publish only on v* tags and workflow_dispatch');
  if (/\bpush:\s*true/.test(JSON.stringify(smoke)) || smoke.steps.some((s) => s.with?.push === true)) problems.push('docker.yml: build-smoke must not push');
  const runs = (job) => job.steps.map((s) => s.run ?? '').join('\n');
  if (!/smoke\.sh/.test(runs(smoke))) problems.push('docker.yml: build-smoke must run infra/allinone/smoke.sh');
  if (!/docker load/.test(runs(publish))) problems.push('docker.yml: publish must push the image that passed the smoke');
  const tagStep = runs(publish);
  if (!/GITHUB_REF_NAME#v/.test(tagStep) || !/latest/.test(tagStep) || !/GITHUB_SHA::7/.test(tagStep)) problems.push('docker.yml: tags must be version + latest on v*, latest + short sha on dispatch');
  if (wf.env?.IMAGE !== 'ghcr.io/er-dhruvmishra/indiansassist') problems.push('docker.yml: the image must be ghcr.io/er-dhruvmishra/indiansassist');
  return problems;
}
