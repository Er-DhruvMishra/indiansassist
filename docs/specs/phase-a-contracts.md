# Phase A technical contracts (binding)

Status: binding for Phase A. Revision 2, 23 Oct 2026 (review round 1 applied; revision 1 was the same day). Implements PRD section 14 "Phase A" plus the multi-region knock-on in PRD section 15.4. Everything in `packages/shared`, `packages/db`, `apps/api`, `apps/web` and `infra` is built from this document, in parallel, without further coordination. If something here is wrong, amend this file first, then the code. Where this document and ADR 0001 differ, this document wins (ADR 0001 carries an amendment note pointing here). Section 15 lists every place this document deviates from or amends the PRD.

Vocabulary (inverted, fix it now): **Desk** = the employee's computer being helped. **Assist** = the technician console.

Conventions used throughout:

| Convention | Rule |
|---|---|
| IDs | UUID v4, Postgres `gen_random_uuid()`, lower-case string in JSON |
| Timestamps in REST JSON | ISO 8601 UTC with milliseconds, e.g. `2026-10-23T10:15:30.123Z` |
| `ts` fields on WS and data-channel messages | integer milliseconds since the Unix epoch (`Date.now()`), never a string |
| Other time fields on WS messages (`knockedAt`, `expiresAt`, `endedAt`, `startedAt`, `iceExpiresAt`) | ISO 8601 UTC with milliseconds, like REST |
| Timestamps in the signed token | Unix seconds (integer) |
| Timestamps in the audit hash material | ISO 8601 UTC with exactly three fractional digits and `Z` (section 5.2) |
| JSON keys | camelCase on the wire (REST, WS, data channel); snake_case in Postgres; the hash chain uses the snake_case shape in section 5 |
| Enums | lower snake_case string literals exactly as listed; never numbers |
| Hex | lower-case |
| base64url | RFC 4648 section 5, no padding. Public keys are **always** base64url (well-known, env, token `kid` derivation input); hex is used only for sha256 digests, `kid` and the signing seed |
| 64-bit integers | `seq`, `bytes` and every other `bigint` column is `bigint(..., { mode: 'number' })` in Drizzle and a plain JSON number on the wire; values stay below 2^53 |
| Secret compares | every compare of a secret or hash (cookie hash, invite hash, resume key hash, presign signature, TURN credential, short code) uses `crypto.timingSafeEqual` on equal-length buffers; a length mismatch is a failure, never an exception |
| Ports (dev) | api `4000`, metrics `9464`, web `5173`, postgres `5432`, valkey `6379`, coturn `3478` udp/tcp and `5349` tls, seaweedfs s3 `8333` |
| Package names | `@indiansassist/shared`, `@indiansassist/db`, `@indiansassist/api`, `@indiansassist/web` |
| Libraries | Fastify 5, `ws`, Drizzle ORM, `pg`, `@electric-sql/pglite`, zod, `@noble/ed25519` (v2, async API), `@noble/hashes`, `argon2`, `prom-client`, React 18, Vite, Tailwind, vitest |

---

## 1. Regions and topology

| Code | Name | Default | Notes |
|---|---|---|---|
| `in-mum` | India (Mumbai) | yes | PRD 15.4 India default |
| `eu-fra` | EU (Frankfurt) | no | export clients, EU |
| `us-east` | US East | no | export clients, US / Middle East |

Constants exported by `@indiansassist/shared` (`regions.ts`):

```ts
export const REGIONS = ['in-mum', 'eu-fra', 'us-east'] as const;
export type Region = (typeof REGIONS)[number];
export const DEFAULT_REGION: Region = 'in-mum';
export const REGION_LABELS: Record<Region, string>; // 'India (Mumbai)', 'EU (Frankfurt)', 'US East'
export function isRegion(x: unknown): x is Region;
```

### 1.1 Topology (binding)

| # | Rule |
|---|---|
| T1 | **One region cluster = one Postgres database, one object-store bucket, one presence store (Valkey) and one coturn.** There is **no shared control plane and no global directory in Phase A.** `org`, `user`, `auth_session`, `token`, `session`, `audit_entry`, `recording` and every other row live only in the database of the org's region. Nothing is replicated or copied between regions. |
| T2 | A node knows only its own region's data. Consequently a node can answer `421 region_mismatch` **only when the region is carried in the request itself**: the signed token payload (`reg`) and the signup body (`region`). Everything else that belongs to another region is simply unknown here: a cookie minted in another region is `401 unauthenticated`, a login for an email that exists only in another region is `401 invalid_credentials`, a short code issued in another region is `404 token_not_found`. The web app follows `421` **only** for the token lookup (section 6.7) and for signup (section 6.5); it never redirects on `401` or `404`. |
| T3 | Login region discovery is a **client-side region picker** (binding choice; the alternative, a global `auth/locate` directory, is rejected for Phase A because it would be the one cross-region datastore). `/login` shows a region selector when the build's `VITE_REGION_ORIGINS` (section 11.2) contains more than one distinct origin; choosing a region navigates to that origin's `/login`; the choice is remembered in `localStorage['ia.region']`. Each region cluster has its own `WEB_ORIGIN` (`API_ORIGIN === WEB_ORIGIN` in production, section 11.4). |
| T4 | In single-node dev (`SERVED_REGIONS` empty) one database holds orgs of every region and `421` never fires. Tests cover `421` by setting `SERVED_REGIONS` to a single region. |
| T5 | Short codes are **not routable across regions**. A short code is unique within one region's database; typed on the wrong region's join page it answers `404 token_not_found` and the join page says "If you were sent a link, open the link instead; codes only work on your organisation's region site". The dashboard shows the code together with the join page host it is valid on. |

### 1.2 Region rules

| # | Rule |
|---|---|
| R1 | `org.data_region` is set once at signup and is immutable. The DB enforces it with trigger `org_region_immutable` (BEFORE UPDATE, raises `data_region is immutable` when `NEW.data_region <> OLD.data_region`). The API exposes no endpoint that writes it. |
| R2 | Each API node declares the regions it serves with env `SERVED_REGIONS` (comma list). Empty or unset means "all regions" (single-node dev). Production sets exactly one region per cluster. |
| R3 | **Compact token lookups and `desk.hello`**: the served-region check runs on the signed payload `reg` **before any database access** (section 3.5 step 4). If `reg` is not served, the API answers `421 region_mismatch` with `details: { region, origin }`, `origin` from `REGION_ORIGINS` (section 11.1) or `null` when the region has no entry. **Signup**: see R5. **Authenticated requests and Assist WS connections**: the org of the authenticated user is always local (T1); the API still asserts `org.data_region ∈ SERVED_REGIONS` as a defence-in-depth check and answers `421` if it ever fails (it indicates a misconfigured node, and is logged at `error`). The web app follows `origin` only when it is in the build's `VITE_REGION_ORIGINS` allow-list (and `https:` in production); otherwise it shows "This organisation is hosted in <REGION_LABELS[region]>; open the link on that region's site" with a manual, non-clickable origin when one is known. |
| R4 | The region appears in: token payload `reg`, every `audit_entry.region`, `auth_session.region`, storage keys (section 9), the residency report (section 6.3) and `GET /api/v1/health`. |
| R5 | Signup takes `region` (optional, default `DEFAULT_REGION`). If the chosen region is not served by this node the API answers `421 region_mismatch` before creating anything; the web app redirects signup to that region's origin under the R3 allow-list rule. |
| R6 | A token signed for region X verifies only on nodes serving X (section 3.5). Session data, recordings and audit rows are never copied across regions (T1). |

---

## 2. Package tiers and roles

### 2.1 Tier enum (`PackageTier`)

| Value | PRD package | Phase A behaviour |
|---|---|---|
| `p1_browser` | Package 1, browser screen share | fully functional |
| `p2_extension` | Package 2 | token can be created; `/join` shows "client not available yet" stub; `desk.hello` answers `error join_unsupported` |
| `p3_portable` | Package 3 | same stub |
| `p4_installed` | Package 4 | same stub; the only tier allowed with `typ = enrollment` |

Order (for "at least tier" checks): `p1_browser < p2_extension < p3_portable < p4_installed`. Shared exports `TIER_ORDER: Record<PackageTier, number>` (0..3).

### 2.2 Role enum (`UserRole`)

| Value | Meaning |
|---|---|
| `technician` | runs sessions with own tokens |
| `senior_technician` | technician plus read access to every token and session in the org, and may accept or deny knocks on any token in the org |
| `org_admin` | everything, including users, branding, seats; may accept or deny knocks on any token in the org |
| `auditor` | read-only: audit, residency, sessions, recordings metadata and download |
| `observer` | read-only: dashboard, sessions list and detail; no audit export, no recordings. (Distinct from the future *supervisor* participant of section 4.1; the two are never conflated.) |

### 2.3 Permission matrix

`own` = for tokens, objects where `created_by` is the caller; for sessions, objects where `assist_user_id` **or** `token.created_by` is the caller (a technician always sees sessions on their own tokens even when a senior accepted the knock). `org` = any object in the caller's org.

| Capability | technician | senior_technician | org_admin | auditor | observer |
|---|---|---|---|---|---|
| auth.me / logout / change own password | yes | yes | yes | yes | yes |
| org get | yes | yes | yes | yes | yes |
| org branding patch | no | no | yes | no | no |
| residency report | no | no | yes | yes | no |
| users list | no | yes | yes | yes | no |
| users invite / role change / status change | no | no | yes | no | no |
| tokens create | yes (own seat tier or lower) | yes (own seat tier or lower) | yes (own seat tier or lower) | no | no |
| tokens list / get | own | org | org | org | no |
| tokens revoke | own | org | org | no | no |
| knock accept / deny (WS `assist.accept` / `assist.deny`) | own tokens | org | org | no | no |
| sessions list / get / stats | own | org | org | org | org |
| sessions end | own | org | org | no | no |
| sessions events (file.*, recording.started) | assist of the session | assist of the session | assist of the session | no | no |
| audit list by session | own | org | org | org | no |
| audit org list | no | org | org | org | no |
| audit export JSONL / verify | no | no | org | org | no |
| recordings upload | assist of the session | assist of the session | assist of the session | no | no |
| recordings metadata / download / verify | own | org | org | org | no |
| ice | yes | yes | yes | no | no |
| WS /signal as Assist | yes | yes | yes | no | no |

A role check failure is `403 forbidden`. An object in the caller's org that is outside the caller's scope (an `own` failure) is also `403 forbidden` (existence is not secret within an org). A cross-org object is `404 not_found` (never reveal existence). `Session.recordingId` is visible to observers, but every recording route answers `403 forbidden` for them.

### 2.4 Seats

Every user with role `technician`, `senior_technician` or `org_admin` has exactly one `technician_seat` row; its `tier` caps the tier of tokens that user may create (`400 tier_not_licensed` otherwise). **This applies to `org_admin` too** (binding resolution of the 2.3 vs 2.4 ambiguity): an admin is capped by their own seat tier and may raise it with `PATCH /api/v1/users/:id/role { role: 'org_admin', tier }` on themselves (audit `user.role_changed` carries `fromTier` / `toTier`). A seat with `active = false` blocks `POST /api/v1/tokens` with `400 tier_not_licensed`. The `tier` given on invite or role change must satisfy `TIER_ORDER[tier] <= TIER_ORDER[org.plan_tier]`, else `400 tier_not_licensed`. Signup creates the first seat with tier `p1_browser`; `org.plan_tier` defaults to `p1_browser` and has no write endpoint in Phase A. `auditor` and `observer` have no seat. Billing is out of scope; the seat table only exists so counting works later.

---

## 3. Signed support token

### 3.1 Format

```
ia1.<kid>.<base64url(payload)>.<base64url(ed25519 signature)>
```

Four dot-separated segments. `kid` is 16 lower-case hex chars (first 16 hex chars of sha256 over the 32 public key bytes) so a verifier selects the key in O(1) and a compromised key can be retired immediately (section 3.4). `payload` is the canonical JSON (section 5.1 rules) of exactly these ten fields, no extras:

| Field | Type | Value |
|---|---|---|
| `v` | int | `1` |
| `tid` | string | token id (UUID, equals `token.id`) |
| `org` | string | org id |
| `by` | string | creating user id |
| `tier` | `PackageTier` | tier |
| `typ` | `one_time` \| `timed` \| `enrollment` | lifetime policy |
| `reg` | `Region` | org region |
| `iat` | int | issued at, unix seconds (`floor(token.issued_at)`) |
| `exp` | int | expiry, unix seconds (`floor(token.expires_at)`) |
| `nonce` | string | base64url of 16 random bytes. Purpose: makes two tokens with otherwise identical fields distinct and binds the compact string to one row; it is compared with `token.nonce` in section 3.5 step 6. |

Signature: Ed25519 (`@noble/ed25519` v2, `signAsync` / `verifyAsync`, sha512 wired from `@noble/hashes/sha512`) over the UTF-8 bytes of the canonical payload (not over the base64url). Signing key: 32-byte seed from env `TOKEN_SIGNING_KEY` (hex). ADR 0001 listed an eight-field payload and a three-segment format; this section supersedes it and the ADR carries an amendment note.

Shared exports (`token.ts`), exact signatures:

```ts
export type TokenPayload = { v: 1; tid: string; org: string; by: string; tier: PackageTier; typ: TokenType; reg: Region; iat: number; exp: number; nonce: string };
export type PublicKeyEntry = { kid: string; pub: Uint8Array };          // pub = 32 raw bytes
export function publicKeyFromSeed(seedHex: string): Promise<Uint8Array>;
export function kidOf(pub: Uint8Array): string;                         // first 16 hex of sha256(pub)
export function signToken(payload: Omit<TokenPayload, 'v' | 'nonce'>, seedHex: string):
  Promise<{ compact: string; payload: TokenPayload; signature: string; kid: string }>; // signature = base64url
export function parseToken(compact: string):
  | { ok: true; kid: string; payload: TokenPayload; signature: string; payloadBytes: Uint8Array }
  | { ok: false; error: 'token_malformed' };                           // runs steps 1-2 of 3.5
export function verifyTokenSignature(parsed: { kid: string; payloadBytes: Uint8Array; signature: string }, keys: PublicKeyEntry[]):
  Promise<boolean>;                                                     // false when no key has parsed.kid
export function normaliseTokenInput(s: string):
  | { kind: 'compact'; value: string } | { kind: 'short_code'; value: string } | null;
```

Example (shape only): `ia1.3f9a1c2b4d5e6f70.eyJ2IjoxLCJ0aWQiOi...fQ.mZ3Q9...` (total length about 350 chars).

### 3.2 Types and lifetimes

| `typ` | Default lifetime | Maximum | Reuse | Allowed tiers |
|---|---|---|---|---|
| `one_time` | 15 minutes | 60 minutes | one session that reaches `active`, after which `status = used` (set on the first `active` transition, **not** at accept, so a Desk who declines by mistake or cancels the picker can knock again on the same link; `token_busy` already blocks a second Desk while the first session is live) | all |
| `timed` | 60 minutes | 480 minutes (one shift; PRD 6 says attended tokens expire "fast (minutes)", so the earlier 1440 maximum is lowered) | any number of sequential sessions until `exp`; at most one non-ended session at a time | all |
| `enrollment` | 7 days | 30 days | reserved for P4; cannot join in Phase A (`desk.hello` answers `join_unsupported`) | `p4_installed` only (`400 invalid_token_type` otherwise) |

Create request uses `ttlMinutes` for attended types and `ttlDays` for enrollment (section 6.7). The zod schema has a refinement: `ttlMinutes` is allowed only with `one_time` / `timed`, `ttlDays` only with `enrollment`; the wrong field, or both, is `400 validation_failed`. Values above the maximum are `400 validation_failed`. Shared exports `TOKEN_LIFETIMES = { one_time: { defaultMin: 15, maxMin: 60 }, timed: { defaultMin: 60, maxMin: 480 }, enrollment: { defaultDays: 7, maxDays: 30 } }`.

### 3.3 Short code

A **12-digit** code shown to the Desk and in the dashboard as three groups of four: `4821 9365 7710` (the 9-digit code of revision 1 is replaced; the space is about 9 x 10^11 instead of 9 x 10^8 because the code is globally unique per region and is the weakest credential in the system). Stored in `token.short_code` as 12 digits without spaces. Generated with a CSPRNG; first digit `1`-`9`; retried on unique collision among tokens with `status = active`. Input normalisation (`normaliseTokenInput(s)` in shared): trim; if the string starts with `ia1.` it is a compact token (all whitespace removed) => `{ kind: 'compact' }`; else strip everything that is not a digit and require exactly 12 digits => `{ kind: 'short_code' }`; anything else => `null`. A full join URL is handled by the join page, which extracts `t` from the fragment or query before calling `normaliseTokenInput`.

Short code rules (binding):

| # | Rule |
|---|---|
| S1 | The short code resolves to the same `tokenId`; it is a convenience path for a Desk that cannot click the link. |
| S2 | **Single failure answer.** Every short-code failure on the public lookup and on `desk.hello` (unknown code, code of a `used` / `revoked` / `expired` token, code from another region) answers `404 token_not_found` (WS: `error token_not_found`). The `410 token_gone` details are given only to compact tokens, which already prove possession. (The UX suggestion to resolve the most recent token by code and answer `410` is deliberately rejected: it would make the lookup an oracle.) |
| S3 | **Rate limits.** Per IP 30 / minute (section 6.12) **plus** a per-node failure budget: when more than 300 short-code misses occur in any sliding 60 s window on this node, short-code lookups answer `429 rate_limited` (`details.retryAfterSec`) for the next 5 minutes and the API logs one `warn` line `short_code_budget_exhausted` (an alert hook). Compact-token lookups are unaffected. |
| S4 | **Reduced disclosure.** A `PublicToken` or `desk.hello.ok` resolved by short code has `technician: null`; the technician's name is disclosed to the Desk only in `session.created` (after a human accepted the knock). Compact-token lookups include `technician: { name }`. |
| S5 | Codes are unique per region and are not routable across regions (section 1.1 T5). |

### 3.4 Public key discovery

`GET /.well-known/indiansassist.json` (unauthenticated, no prefix, `Cache-Control: public, max-age=300`):

```json
{
  "v": 1,
  "region": "in-mum",
  "keys": [{ "kid": "3f9a1c2b4d5e6f70", "alg": "Ed25519", "pub": "<base64url 32 bytes>", "createdAt": "2026-10-23T00:00:00.000Z" }],
  "api": "http://localhost:4000/api/v1",
  "signal": "ws://localhost:4000/signal",
  "join": "http://localhost:5173/join"
}
```

Verifiers select the key whose `kid` equals the token's `kid` segment; the list allows rotation (retired public keys from `TOKEN_SIGNING_KEYS_PREVIOUS`, base64url, stay listed until every token signed with them has expired). To retire a key immediately after a compromise, remove it from `TOKEN_SIGNING_KEYS_PREVIOUS`: every token carrying its `kid` then fails step 3. The verifying key's `kid` must also equal the stored `token.kid` (step 6), so a retired key cannot re-sign the payload of an existing row.

### 3.5 Verification (server side, in this order)

| Step | Check | Failure code |
|---|---|---|
| 1 | four dot-separated parts, first is `ia1`, second is 16 lower-case hex chars | `token_malformed` |
| 2 | payload decodes to JSON; re-canonicalising it yields identical bytes; `v === 1`; all ten fields present with correct types and enum values | `token_malformed` |
| 3 | a key with `kid` equal to segment two exists in the node's key set (current key or `TOKEN_SIGNING_KEYS_PREVIOUS`) and the Ed25519 signature verifies with it | `token_bad_signature` (HTTP 400) |
| 4 | **served-region check, before any DB access**: `payload.reg ∈ SERVED_REGIONS` (or `SERVED_REGIONS` empty) | `region_mismatch` with `details: { region: reg, origin: REGION_ORIGINS[reg] ?? null }` |
| 5 | `iat <= now + 60` and `now < exp` | `token_gone` with `details.status = 'expired'` |
| 6 | DB row `token.id = tid` exists and `org_id = org`, `created_by = by`, `tier`, `typ`, `region`, `nonce === token.nonce`, `kid === token.kid` (the key that verified in step 3), `exp === floor(epochSeconds(token.expires_at))`, `iat === floor(epochSeconds(token.issued_at))` all match | `token_not_found` |
| 7 | `token.status === 'active'` (when step 5 fails on an `active` row the API also sets `status = expired` lazily). **Resume exception:** when the call is a `desk.hello` carrying a `resumeKey` whose `sha256Hex` equals (constant-time) `session.resume_key_hash` of a non-ended session on this token, `status = used` is also accepted (a `one_time` token that reached `active` may be resumed). | `token_gone` with `details.status` (`used` \| `revoked` \| `expired`) |
| 8 | `reg === org.data_region` (sanity; the org row is local by T1) | `region_mismatch` |

A short code skips steps 1-5 and resolves the row by `short_code` among `status = active` tokens of this node's database, then runs steps 6 (row-internal checks only), 7 and 8 plus the `exp` check; **every** short-code failure is reported as `token_not_found` (section 3.3 S2). The resume exception applies to short codes too (the Desk that joined by code still holds a `resumeKey`). The join page may pre-check steps 1-3 and 5 with the published key, but the server check is authoritative. A `desk.hello` on a `p2_extension`, `p3_portable`, `p4_installed` or `typ = enrollment` token passes verification and then answers `error join_unsupported` (close `4403`).

### 3.6 Links

| Link | Value |
|---|---|
| join link (what the dashboard copies, and what the QR encodes) | `${WEB_ORIGIN}/join#t=<compact token>` |
| download link (serves the P1 join page in Phase A; the per-download stub of PRD 6.3 / PRD 11 arrives with Phase C) | `${WEB_ORIGIN}/download#t=<compact token>` redirects (client side) to `/join#t=` |
| invite link | `${WEB_ORIGIN}/invite#i=<secret>` |

**The bearer token travels in the URL fragment, never in the query or path**: a fragment is not sent to any server, is not written to nginx or pino access logs and is not included in `Referer`. For compatibility with the PRD wording the pages also accept `?t=` / `?i=` and immediately move the value to memory and `history.replaceState` the URL to the bare path (section 6.13 step 1). `GET /api/v1/download?t=` is reserved for the Phase C per-download stub (section 14).

---

## 4. Database schema (Drizzle, Postgres)

Owned by `@indiansassist/db`. Table names are singular snake_case (`user` is quoted by Drizzle). All `timestamptz` default `now()` unless noted and are declared `timestamp(..., { withTimezone: true, mode: 'date' })`; `audit_entry.ts` and `audit_checkpoint.ts` additionally use `precision: 3`. All `id` are `uuid primary key default gen_random_uuid()`. "fk X" means `references X(id)`; default `on delete restrict` unless stated. Every `updated_at` column is maintained by Drizzle `$onUpdate(() => new Date())`, not by a DB trigger. Every `bigint` column is `{ mode: 'number' }`.

### 4.1 Postgres enums (pgEnum name: values)

| Enum | Values |
|---|---|
| `region` | `in-mum`, `eu-fra`, `us-east` |
| `package_tier` | `p1_browser`, `p2_extension`, `p3_portable`, `p4_installed` |
| `user_role` | `technician`, `senior_technician`, `org_admin`, `auditor`, `observer` |
| `user_status` | `invited`, `active`, `disabled` |
| `token_type` | `one_time`, `timed`, `enrollment` |
| `token_status` | `active`, `used`, `revoked`, `expired` |
| `session_state` | `knocked`, `accepted`, `consent_pending`, `active`, `ended` |
| `consent_state` | `pending`, `granted`, `revoked` |
| `session_path` | `unknown`, `p2p`, `relay` |
| `session_end_reason` | `denied`, `timeout`, `desk_left`, `desk_stopped`, `consent_revoked`, `assist_ended`, `token_revoked`, `error` |
| `participant_role` | `assist`, `desk`, `supervisor` (renamed from `observer` so the dashboard role and the future supervisor participant never share a word) |
| `actor_type` | `user`, `desk`, `system` |
| `recording_status` | `uploading`, `stored`, `failed` |
| `file_direction` | `assist_to_desk`, `desk_to_assist` |
| `checkpoint_kind` | `periodic`, `verify`, `export` |
| `integration_type` | `zoho_desk`, `servicenow`, `jira`, `freshdesk` |
| `device_status` | `enrolled`, `disabled` |

### 4.2 Tables

**org**

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| name | text | no | |
| slug | text | no | unique, `^[a-z0-9-]{3,40}$` |
| data_region | region | no | immutable (trigger `org_region_immutable`) |
| plan_tier | package_tier | no | `p1_browser`; caps seat tiers (section 2.4) |
| branding | jsonb | no | `{}`; shape `{displayName?, logoData?, accentColor?, supportEmail?}` (`logoData` is a `data:image/png;base64,` or `data:image/jpeg;base64,` URL, max 200 KiB; external logo URLs are not accepted, section 6.6) |
| audit_pepper | char(64) | no | hex of 32 CSPRNG bytes generated at signup; used to hash PII in audit `data` (section 5.3); destroying it is the Phase E erasure mechanism |
| sso_config | jsonb | yes | null (Phase E) |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

**user**

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| org_id | uuid | no | fk org on delete restrict; index (org deletion is not a Phase A operation; `restrict` everywhere keeps the chain's fks satisfiable) |
| email | text | no | unique index on `lower(email)` |
| name | text | no | |
| role | user_role | no | |
| status | user_status | no | `active` |
| password_hash | text | yes | argon2id PHC string; null for OIDC / invited users |
| auth_provider | text | no | `local` |
| auth_ref | text | yes | OIDC subject (Phase E) |
| invite_token_hash | char(64) | yes | sha256 hex of invite secret; nulled on acceptance |
| invite_expires_at | timestamptz | yes | nulled on acceptance |
| last_login_at | timestamptz | yes | |
| created_at / updated_at | timestamptz | no | now() |

**technician_seat**: `id` pk; `org_id` uuid not null fk org, index; `user_id` uuid not null fk user on delete cascade, unique; `tier` package_tier not null default `p1_browser`; `active` boolean not null default true (inactive => `400 tier_not_licensed` on token creation); `created_at`, `updated_at` timestamptz not null default now().

**auth_session** (cookie sessions): `id` pk; `user_id` uuid not null fk user on delete cascade, index; `token_hash` char(64) not null unique (`sha256Hex(v)` of the raw cookie value `v`, section 6.1); `region` region not null (copy of the org's `data_region`, R4); `user_agent` text null; `ip` text null; `created_at` timestamptz not null default now(); `last_seen_at` timestamptz not null default now(); `expires_at` timestamptz not null (set by the API: created_at + 7 days); `revoked_at` timestamptz null.

**login_attempt** (mutable, not part of the chain): `id` pk; `email_hash` char(64) not null index (`sha256Hex(lower(email))`, no pepper, so lockout works for unknown emails too); `ip` text null; `success` boolean not null; `at` timestamptz not null default now(). Used for lockout (section 6.5); rows older than 24 h are deleted by the sweeper (section 7.6).

**device** (P4 placeholder, no writes in Phase A): `id` pk; `org_id` uuid not null fk org, index; `name` text not null; `public_key` text null (base64url Ed25519); `status` device_status not null default `enrolled`; `group_name` text null; `tags` text[] not null default `{}`; `capabilities` jsonb not null default `{}`; `enrolled_by_token_id` uuid null fk token; `last_seen_at` timestamptz null; `created_at`, `updated_at` timestamptz not null default now().

**token**

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk (= payload `tid`) |
| org_id | uuid | no | fk org; index |
| created_by | uuid | no | fk user; index |
| tier | package_tier | no | |
| typ | token_type | no | |
| status | token_status | no | `active`; index (org_id, status) |
| short_code | char(12) | no | unique partial index `where status = 'active'` |
| label | text | yes | free text shown in dashboard, max 80, sanitised (section 5.3) |
| region | region | no | copy of org.data_region |
| kid | text | no | signing key id (16 hex) |
| signature | text | no | base64url signature part |
| nonce | text | no | payload `nonce` |
| issued_at | timestamptz(3) | no | `iat` = floor(epoch seconds) |
| expires_at | timestamptz(3) | no | index; `exp` = floor(epoch seconds) |
| used_at | timestamptz | yes | set on the first `active` transition of a `one_time` token |
| revoked_at | timestamptz | yes | |
| revoked_by | uuid | yes | fk user; null for `auto_denied` |
| denied_count | integer | no | `0`; consecutive denials, reset on accept; `3` => auto-revoke (section 7.3) |
| created_at | timestamptz | no | now() |

The compact token string is **not** stored; it is returned once at creation and can be rebuilt from the row (`kid` + payload fields + signature).

**session**

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| org_id | uuid | no | fk org; index (org_id, created_at desc) |
| token_id | uuid | no | fk token; index |
| assist_user_id | uuid | no | fk user; index. **The user who accepted the knock** (may differ from `token.created_by`) |
| desk_label | text | yes | sanitised label typed by the Desk (max 80); `desk.knock.deskLabel ?? desk.hello.deskLabel ?? 'Desk'` |
| desk_ref | text | no | the Desk's **first** WS connection id (uuid); never changes on resume |
| desk_user_agent | text | yes | sanitised, max 512 |
| resume_key_hash | char(64) | yes | sha256 hex of the Desk resume key |
| tier | package_tier | no | copied from token.tier (named `tier` everywhere: column, wire, WS) |
| state | session_state | no | `knocked`; index (org_id, state) |
| consent_state | consent_state | no | `pending` |
| consent_surface | text | yes | `monitor` \| `window` \| `browser` \| `unknown` |
| path | session_path | no | `unknown` |
| region | region | no | copy of org.data_region |
| node_id | text | no | `NODE_ID` of the API node that owns the session's timers (section 7.6) |
| knocked_at | timestamptz | no | now() |
| knock_expires_at | timestamptz | yes | `knocked_at + 120 s` while `knocked`; null afterwards |
| consent_deadline_at | timestamptz | yes | `+ 180 s` from each `session.created` while `consent_pending`; null afterwards |
| accepted_at | timestamptz | yes | |
| consent_at | timestamptz | yes | |
| started_at | timestamptz | yes | first `active`; never overwritten by a later resume |
| ended_at | timestamptz | yes | |
| end_reason | session_end_reason | yes | |
| last_stats | jsonb | yes | last `session.stats` payload (section 7.3) |
| recording_started | boolean | no | `false`; set by the first `recording.started` event (section 6.8) |
| hash_chain_tail | char(64) | yes | hash of the last audit entry for this session |
| created_at / updated_at | timestamptz | no | now() |

There is **no** `session.recording_id` column (the circular fk of revision 1 is dropped); the wire field `Session.recordingId` is derived from `recording.session_id` (unique).

**session_participant**: `id` pk; `session_id` uuid not null fk session on delete cascade, index; `role` participant_role not null; `user_id` uuid null fk user (set for assist / supervisor); `label` text not null (display name); `connection_id` text not null (WS connection id); `joined_at` timestamptz not null default now(); `left_at` timestamptz null. Phase A writes `assist` and `desk` rows; `supervisor` is reserved for supervisor join. On every resume the previous row of that side gets `left_at` and a new row is inserted with the new `connection_id`, so the participant history of a session is complete.

**session_file** (mutable; plaintext file names live here, the chain holds hashes): `id` pk; `session_id` uuid not null fk session on delete cascade; `direction` file_direction not null; `file_id` integer not null; unique (session_id, direction, file_id); `name` text not null (output of `sanitiseFileName`); `bytes` bigint not null; `assist_sha256` char(64) null; `desk_sha256` char(64) null; `assist_entry_id` uuid null fk audit_entry; `desk_entry_id` uuid null fk audit_entry; `created_at`, `updated_at` timestamptz not null default now().

**audit_entry** (append only)

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| org_id | uuid | no | fk org |
| seq | bigint | no | per-org sequence starting at 1; unique (org_id, seq) |
| session_id | uuid | yes | fk session; index |
| actor_type | actor_type | no | |
| actor_id | text | yes | user id, desk_ref, or null for system |
| actor_label | text | no | user name / `desk:<first 8 chars of desk_ref>` / `system` (section 5.3) |
| action | text | no | section 5.3 names; index (org_id, action) |
| reason | text | yes | sanitised, max 500 |
| region | region | no | must equal `org.data_region` (checked by `insertAuditEntry`) |
| ts | timestamptz(3) | no | set by the API (no default); millisecond precision so the stored value round-trips to the hashed string |
| data | jsonb | no | `{}`; validated and sanitised **before** hashing (section 5.3); the stored value is byte-for-byte what was hashed |
| prev_hash | char(64) | no | |
| hash | char(64) | no | unique |

Append-only enforcement (migration `0000_init`): function `audit_entry_block()` does `RAISE EXCEPTION 'audit_entry is append-only'`; trigger `audit_entry_immutable` BEFORE UPDATE OR DELETE ON audit_entry FOR EACH ROW EXECUTES it; trigger `audit_entry_no_truncate` BEFORE TRUNCATE ON audit_entry FOR EACH STATEMENT EXECUTES it. When env `DB_APP_ROLE` is set, migrations additionally run `REVOKE UPDATE, DELETE, TRUNCATE ON audit_entry, audit_checkpoint FROM <role>` (skipped on PGlite). **`DB_APP_ROLE` is required when `NODE_ENV=production`**, the role named in `DATABASE_URL` must be that role, and it must not own any table; migrations run with `MIGRATE_DATABASE_URL` (owner role). Triggers are a speed bump against the application role, not against a superuser; the signed checkpoints of section 5.6 are the tamper evidence. `insertAuditEntry()` in the db package is the only write path: in one transaction it takes `SELECT pg_advisory_xact_lock(hashtext(org_id::text))`, reads the org tail (`max(seq)` and its `hash`), computes `seq`, `prev_hash`, `hash` and inserts; it also updates `session.hash_chain_tail` when `session_id` is set.

**audit_checkpoint** (signed anchors and persisted verify results; append only like `audit_entry`, same triggers `audit_checkpoint_immutable`)

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| org_id | uuid | no | fk org; index (org_id, seq desc) |
| kind | checkpoint_kind | no | |
| seq | bigint | no | the chain length anchored |
| tail | char(64) | no | `hash` of entry `seq` |
| ts | timestamptz(3) | no | API generated |
| kid | text | no | signing key id |
| sig | text | no | base64url Ed25519 over `canonicalJson({ org_id, seq, tail, ts })` with `ts` as the 3-digit ISO string |
| anchored_entry_id | uuid | yes | fk audit_entry: the `audit.anchored` entry written right after this checkpoint |
| verify_ok | boolean | yes | `kind = verify` only |
| verify_checked | bigint | yes | |
| verify_failure | jsonb | yes | the `failure` object of section 5.4 |
| created_at | timestamptz | no | now() |

**recording**

| Column | Type | Null | Default / constraint |
|---|---|---|---|
| id | uuid | no | pk |
| org_id | uuid | no | fk org; index |
| session_id | uuid | no | fk session; unique (one recording per session in Phase A) |
| uploaded_by | uuid | no | fk user |
| status | recording_status | no | `uploading` |
| storage_key | text | no | section 9 key; unique |
| mime | text | no | `video/webm` |
| bytes | bigint | no | 0 until stored; declared size for chunked uploads |
| sha256 | char(64) | yes | null until stored |
| duration_ms | integer | yes | client supplied |
| chained_into | uuid | yes | fk audit_entry (the `recording.stored` entry) |
| upload_id | text | yes | chunked upload id |
| upload_expires_at | timestamptz | yes | `created_at + 24 h` while `uploading`; the sweeper fails and cleans expired uploads (section 9) |
| region | region | no | |
| created_at | timestamptz | no | now() |
| stored_at | timestamptz | yes | |

**integration** (schema only in Phase A): `id` pk; `org_id` uuid not null fk org; `type` integration_type not null; unique (org_id, type); `config` jsonb not null default `{}`; `enabled` boolean not null default false; `created_at`, `updated_at` timestamptz not null default now().

### 4.3 db package API

```ts
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;            // satisfied by node-postgres and PGlite drivers; carries the schema generic so db.query.* works

export function createDb(opts: { databaseUrl: string; pgliteDir?: string }): Promise<Db>; // '' => PGlite at pgliteDir; 'memory://' => in-memory PGlite
export function migrate(db: Db): Promise<void>;                                       // drizzle-kit migrations in packages/db/drizzle/ (journal committed; triggers via `drizzle-kit generate --custom`)
export function closeDb(db: Db): Promise<void>;
export const schema: { org, user, technicianSeat, authSession, loginAttempt, device, token, session, sessionParticipant, sessionFile, auditEntry, auditCheckpoint, recording, integration, /* pgEnums */ };

export type AuditEntryRow = typeof schema.auditEntry.$inferSelect;                      // snake_case drizzle row; the API owns the mapping to the wire `AuditEntry` of 6.3
export type AuditInput = {
  orgId: string;
  sessionId?: string | null;                 // default null
  actor: { type: ActorType; id: string | null; label: string };
  action: AuditAction;
  reason?: string | null;                    // default null
  region: Region;                            // must equal org.data_region, else throws
  data?: AuditData;                          // default {}; validated with auditDataSchema(action) from shared BEFORE hashing, throws ZodError otherwise
  ts?: Date;                                 // default new Date(); truncated to whole milliseconds
};
export function insertAuditEntry(db: Db, input: AuditInput): Promise<AuditEntryRow>;   // section 5
export function toChainEntry(row: AuditEntryRow): ChainEntry;                            // row -> nested hashed shape + hash (section 5.4); ts = new Date(row.ts).toISOString()
export function insertAuditCheckpoint(db: Db, input: { orgId: string; kind: CheckpointKind; seq: number; tail: string; ts: Date; kid: string; sig: string; verify?: { ok: boolean; checked: number; failure?: VerifyFailure } }): Promise<AuditCheckpointRow>;
```

Migrations live in `packages/db/drizzle/` with drizzle-kit's `0000_init` numbering and `meta/_journal.json` committed (the `packages/db/migrations` / `0001_init` naming of revision 1 is withdrawn). Tests run on `memory://`. The db test plan includes a round-trip test: insert one entry with every `data` type, read the row back, `toChainEntry(row)`, recompute the hash and compare with `row.hash`.

---

## 5. Audit hash chain

### 5.1 Canonical JSON

RFC 8785 (JCS) subset implemented in `@indiansassist/shared` as `canonicalJson(value): string`:

| Rule |
|---|
| Object keys sorted by UTF-16 code unit order; no whitespace |
| Strings escaped per JSON with minimal escapes (`"`, `\\`, control chars as `\uXXXX` except `\b \f \n \r \t`) |
| Numbers: integers only in hashed material, serialised as `String(n)`; non-finite numbers, non-integers and `bigint` are rejected with an error |
| `null` kept; `undefined` properties dropped before hashing (the material of section 5.2 never contains `undefined`: every one of its ten keys is present and `null` is written explicitly) |
| Arrays keep order |
| Encoding: UTF-8 bytes of the resulting string |

`sha256Hex(bytes | string)` uses `@noble/hashes/sha256`.

### 5.2 Hashed shape

`hash = sha256Hex(utf8(canonicalJson(material)))` where `material` is exactly these **ten keys, always all present** (`session_id`, `reason` and `actor.id` are `null` when absent, never omitted):

```json
{
  "action": "session.started",
  "actor": { "id": "<uuid|desk_ref|null>", "label": "Priya S", "type": "user" },
  "data": { },
  "org_id": "<uuid>",
  "prev_hash": "<64 hex>",
  "reason": null,
  "region": "in-mum",
  "seq": 42,
  "session_id": "<uuid|null>",
  "ts": "2026-10-23T10:15:30.123Z"
}
```

| Rule |
|---|
| Genesis: the first entry of an org has `prev_hash = "0000000000000000000000000000000000000000000000000000000000000000"` and `seq = 1` |
| One chain per org; `prev_hash` of entry `seq = n` equals `hash` of entry `seq = n-1` of the same org |
| `ts` is generated by the API as `new Date().toISOString()` (always three fractional digits, `Z`) and stored in the `timestamptz(3)` column; when reading, `ts` is **reconstructed as `new Date(row.ts).toISOString()`**, never from Postgres' text form. The shared and db test plans include a round-trip test of one entry (`material -> row -> material`) |
| `data` is always a JSON object (may be `{}`) containing only strings, integers, booleans, null, nested objects and arrays, validated and sanitised per section 5.3 **before** hashing; the row stores exactly the hashed value |
| `session.hash_chain_tail` is updated to `hash` whenever `session_id` is set |

Shared exports `hashAuditEntry(material): string`, `GENESIS_HASH`, `AuditMaterial` type, `ChainEntry = AuditMaterial & { hash: string }`.

### 5.3 Phase A action names and `data` shapes

**Sanitation rule for everything that enters `data`, `reason` or `actor.label`** (shared `audit/sanitise.ts`, applied by the zod schemas that `insertAuditEntry` runs before hashing): strings are NFC-normalised; C0 controls (U+0000-U+001F), DEL and C1 (U+007F-U+009F), zero-width and bidi controls (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF) are removed; then truncated to the field limit: `userAgent` 512, `deskLabel` / `label` 80, `reason` 500, file `name` 200 (after `sanitiseFileName`, section 8.3), `error` 500, any other string 1000. The same sanitised values are what the mutable columns store (`session.desk_label`, `token.label`, `session_file.name`), so the chain and the display never diverge. Postgres `jsonb` rejects `\u0000`; removing C0 controls guarantees the insert cannot fail after hashing.

**PII rule.** Values typed by or identifying a data subject (email, Desk label, user agent, file name) are **never written in plaintext into `data`**; they are written as `sha256Hex(org.audit_pepper + ':' + value)` under a key ending in `Hash`. Plaintext stays in mutable columns (`user.email`, `session.desk_label`, `session.desk_user_agent`, `session_file.name`) which the API joins for display. Destroying `org.audit_pepper` (Phase E erasure endpoint) makes every hashed PII value unlinkable without touching a chain byte. `actor.label` for a `user` actor is the technician's display name at the time (the technician is the privileged actor the chain exists to record; retention is stated in the residency report); for a `desk` actor it is `desk:<first 8 chars of desk_ref>`; for `system` it is `system`.

| Action | Actor | `data` |
|---|---|---|
| `auth.signup` | user | `{ emailHash }` |
| `auth.login` | user | `{ method: 'local' \| 'invite' }` |
| `auth.login_failed` | system | `{ userId }`. **Written only when the email resolves to a user of this region** (org known); failures for unknown emails go to the structured log and `login_attempt` only. Never contains the typed email. |
| `auth.logout` | user | `{}` |
| `auth.password_changed` | user | `{}` |
| `user.invited` | user | `{ userId, emailHash, role, tier }` (`tier` null when the role has no seat) |
| `user.role_changed` | user | `{ userId, from, to, fromTier, toTier }` (tiers null when no seat) |
| `user.status_changed` | user | `{ userId, from, to, revokedSessions, revokedTokens }` |
| `org.branding_updated` | user | `{ fields: string[] }` |
| `token.created` | user | `{ tokenId, tier, typ, expiresAt }` (the short code is **not** in the chain; the dashboard reads it from the token row) |
| `token.revoked` | user / system | `{ tokenId, reason: 'manual' \| 'auto_denied' \| 'user_disabled' }` |
| `session.knock` | desk | `{ tokenId, deskLabelHash, userAgentHash }` |
| `session.accepted` | user | `{ tokenId, onBehalfOf }` (`onBehalfOf` = `token.created_by` when the acceptor is not the creator, else `null`) |
| `session.denied` | user | `{ tokenId, revokeToken: boolean }` (`reason` column holds the typed reason, may be null) |
| `session.consent_granted` | desk | `{ surface }` (`monitor` \| `window` \| `browser` \| `unknown`) |
| `session.consent_revoked` | desk | `{}` |
| `session.started` | system | `{ path }` |
| `session.resumed` | system | `{ side: 'assist' \| 'desk', fromState, toState }` |
| `session.path_changed` | system | `{ from, to }` |
| `session.ended` | user / desk / system | `{ endReason, durationMs, path }`; `durationMs = ended_at - started_at`, **`null` when the session never reached `active`** |
| `chat.relayed` | system | `{ count }` (written **immediately before** `session.ended`, in the same request, when count > 0) |
| `file.sent` | user / desk | `{ fileId, direction, nameHash, bytes, sha256 }`. Reported by **both** sides: the Assist via `POST /sessions/:id/events`, the Desk via WS `desk.event`. `file.sent` is from the reporter's point of view (Assist reports `file.sent` for `assist_to_desk`; Desk reports `file.sent` for `desk_to_assist`). |
| `file.received` | user / desk | same shape, receiver's point of view |
| `recording.started` | user | `{}` (deduplicated: one per session) |
| `recording.stored` | user | `{ recordingId, sha256, bytes, mime, storageKey }` |
| `recording.failed` | user / system | `{ recordingId, error }` |
| `signal.forbidden` | user | `{ connectionId, messageType, sessionId }`. Written when an **authenticated Assist socket** sends a session-scoped message for a session it is not a participant of (section 7.2). Desk-side attempts are logged only (anonymous; the chain is not a sink for anonymous input). |
| `audit.anchored` | system | `{ seq, tail, ts, kid, sig }` (section 5.6) |
| `audit.exported` | user | `{ format: 'jsonl', count, fromSeq, toSeq }` |
| `audit.verified` | user | `{ ok, checked, failure }` (`failure` null when ok) |
| `elevation.requested` | reserved (P3) | not written in Phase A; name reserved |
| `session.supervisor_joined` | reserved (A.2) | not written in Phase A; name reserved |

`file.*` and `recording.started` on the Assist side are reported via `POST /api/v1/sessions/:id/events` (section 6.8) and `file.*` on the Desk side via WS `desk.event` (section 7.3) because transfers never touch the server. Shared exports `AUDIT_ACTIONS` as a `const` tuple of these names, `AuditAction`, `AuditData`, and `auditDataSchema(action): ZodType` returning the per-action zod schema (with the sanitising transforms above).

### 5.4 Verify algorithm

```
input: entries (ChainEntry: the nested hashed shape plus hash) of one org ordered by seq ascending,
       opts: { orgId, region?, start?: { seq, prevHash }, pubKeys?: PublicKeyEntry[], checkpoint?: { seq, tail } }
expected_prev = start?.prevHash ?? GENESIS_HASH; expected_seq = start?.seq ?? 1
for e in entries:
  if e.org_id != opts.orgId                         -> fail('org_mismatch', e.seq)
  if opts.region and e.region != opts.region        -> fail('region_mismatch', e.seq)
  if e.seq != expected_seq                          -> fail('seq_gap', e.seq)
  if e.prev_hash != expected_prev                   -> fail('prev_mismatch', e.seq)
  if hashAuditEntry(material(e)) != e.hash          -> fail('hash_mismatch', e.seq)
  if e.action == 'audit.anchored' and opts.pubKeys:
     if not ed25519.verify(e.data.sig over canonicalJson({org_id, seq: e.data.seq, tail: e.data.tail, ts: e.data.ts}), key kid=e.data.kid)
                                                    -> fail('anchor_bad_signature', e.seq)
     if entries contains seq e.data.seq and its hash != e.data.tail -> fail('anchor_mismatch', e.seq)
  if opts.checkpoint and e.seq == opts.checkpoint.seq and e.hash != opts.checkpoint.tail
                                                    -> fail('tail_regression', e.seq)
  expected_prev = e.hash; expected_seq += 1
if opts.checkpoint and expected_seq - 1 < opts.checkpoint.seq -> fail('tail_regression', expected_seq - 1)
return { ok: true, checked: n, tail: expected_prev or null when n == 0 and no start }
```

Result: `{ ok: boolean, checked: number, tail: string | null, failure?: { kind: 'org_mismatch' | 'region_mismatch' | 'seq_gap' | 'prev_mismatch' | 'hash_mismatch' | 'anchor_bad_signature' | 'anchor_mismatch' | 'tail_regression', seq: number } }` (`VerifyResult`, `VerifyFailure`). Shared exports `verifyChain(entries: Iterable<ChainEntry>, opts: VerifyOptions): VerifyResult`; the API wraps it, maps rows with `toChainEntry`, streams rows in batches of 1000, passes its own public keys and the latest `audit_checkpoint` of the org. `material(e)` is `e` without `hash` (and without `id` when present).

### 5.5 JSONL export

One JSON object per line, `\n` terminated, UTF-8, ordered by `seq` ascending. **The first line is a header object** (revision 1's "no header line" is withdrawn so that filtered exports verify as a segment):

```json
{"ia_audit_export":1,"orgId":"<uuid>","orgSlug":"acme","region":"in-mum","exportedAt":"2026-10-23T10:15:30.123Z","startSeq":1,"startPrevHash":"000...","count":1234,"keys":[{"kid":"3f9a1c2b4d5e6f70","pub":"<base64url>"}]}
```

Every following line is the hashed shape plus `id` and `hash`:

```json
{"id":"<uuid>","seq":1,"org_id":"<uuid>","session_id":null,"actor":{"id":"<uuid>","label":"Priya S","type":"user"},"action":"auth.signup","reason":null,"region":"in-mum","ts":"2026-10-23T10:15:30.123Z","data":{"emailHash":"9f..."},"prev_hash":"000...","hash":"ab12..."}
```

Removing `id` and `hash` from a line recovers `material` exactly, so the file verifies offline with `verifyChain(lines, { orgId: header.orgId, region: header.region, start: { seq: header.startSeq, prevHash: header.startPrevHash }, pubKeys: header.keys })`. For an unfiltered export `startSeq = 1` and `startPrevHash = GENESIS_HASH`; for a `from`/`to` export they are the first exported entry's `seq` and `prev_hash`. Content type `application/x-ndjson`, filename `audit-<orgSlug>-<yyyymmdd>.jsonl`. The web app's offline verifier reads the header first and treats a file without one as malformed.

### 5.6 Signed checkpoints (anchoring)

The chain alone only proves internal consistency; whoever can write the table can rewrite a consistent chain. Checkpoints add a secret the database does not hold:

| # | Rule |
|---|---|
| C1 | A checkpoint is `{ org_id, seq, tail, ts }` signed with the node's Ed25519 token key (`kid`, same key set as section 3.4, so an exported JSONL verifies offline against `/.well-known`). It is stored in `audit_checkpoint` and, immediately after, an `audit.anchored` entry carrying `{ seq, tail, ts, kid, sig }` is appended to the chain (its `anchored_entry_id` is set on the checkpoint). |
| C2 | Checkpoints are written: on every `POST /api/v1/audit/verify` (`kind = verify`, with the verify result persisted on the same row), on every export (`kind = export`), and by the sweeper every 60 minutes for every org whose tail entry is not itself an `audit.anchored` entry (`kind = periodic`; idle orgs get no new entries). |
| C3 | `verifyChain` receives the latest checkpoint of the org and fails with `tail_regression` when the chain is shorter than `checkpoint.seq` or entry `checkpoint.seq` has a different hash. |
| C4 | `GET /api/v1/audit/verify` returns the latest `kind = verify` checkpoint (persisted, identical on every node). Nothing about verification is kept in process memory. |
| C5 | The residency report (section 6.3) includes `chain.lastAnchor` and the retention statement. Each checkpoint is also written to the structured log at `info` (`audit_checkpoint`, with `orgId`, `seq`, `tail`, `kid`) so an external log sink holds an independent copy. |

---

## 6. REST API

Fastify 5, prefix `/api/v1`, JSON bodies (`Content-Type: application/json`; multipart and octet-stream only for recordings). Served on `PORT` (4000). CORS: `Access-Control-Allow-Origin: ${WEB_ORIGIN}`, `credentials: true`, allowed headers `Content-Type, X-Requested-With`, exposed header `Content-Disposition`. In production `WEB_ORIGIN === API_ORIGIN` (nginx proxies `/api/`, section 11.4) so CORS is effectively same-origin; the header is still emitted. `TRUST_PROXY=true` (Compose) makes Fastify resolve the client IP from `X-Forwarded-For`; every per-IP limit keys on that resolved IP.

**Logging contract (binding).** pino with `redact: ['req.headers.cookie', 'req.headers.authorization', 'req.query', 'req.url', '*.sdp', '*.text', '*.token', '*.compact', '*.resumeKey', '*.invite', '*.password', '*.sig', '*.credential']` (`req.url` is logged as path only via a serializer that strips the query string). Every WS log line carries `connectionId`, and `sessionId` / `orgId` / `userId` when known. Relayed chat text and SDP are never logged at any level. `GET /metrics` (prom-client, default registry plus `ia_ws_connections`, `ia_sessions_active`, `ia_audit_entries_total`, `ia_short_code_misses_total`, `ia_rate_limited_total`) is served on a second listener `METRICS_PORT` (9464) bound to `HOST`, never proxied by nginx.

### 6.1 Auth, cookies, CSRF

| Item | Value |
|---|---|
| Cookie name | `ia_session` |
| Cookie attributes | `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`; `Secure` when `NODE_ENV=production` |
| Cookie value | `v` = 32 CSPRNG bytes as base64url (the raw value); the cookie carries `sign(v)` by `@fastify/cookie` (`secret: SESSION_COOKIE_SECRET`); the DB stores `sha256Hex(v)` in `auth_session.token_hash`. Lookup is by hash; the final compare of the stored and computed hash is constant-time. |
| Session fixation | every successful `signup`, `login` and `accept-invite` mints a **new** `auth_session` row and a new cookie value; an inbound cookie is never reused or upgraded |
| Lifetime | 7 days absolute (`expires_at`); `last_seen_at` refreshed at most once per minute |
| Password hashing | `argon2id` via `argon2` (memoryCost 65536, timeCost 3, parallelism 1); min length 10, max 128 |
| Lockout | after 10 failed attempts for the same `email_hash` within 15 minutes (`login_attempt`), `POST /auth/login` answers `429 rate_limited` for that email for 15 minutes, before checking the password |
| CSRF | every non-GET/HEAD/OPTIONS request under `/api/v1` must carry header `X-Requested-With: IndiansAssist` and, when an `Origin` header is present, it must equal `WEB_ORIGIN`; otherwise `403 csrf_failed`. The WS upgrade applies the same `Origin` check. No GET has a side effect (export is `POST`). |
| Unauthenticated | `401 unauthenticated` (missing, unknown, expired or revoked cookie, including a cookie minted in another region, section 1.1 T2) |
| Web client rule | the web app's "redirect to `/login` on 401" handler applies **only** to responses of `GET /auth/me`; every other 401 is handled by the calling screen |

### 6.2 Error envelope and codes

```json
{ "error": { "code": "validation_failed", "message": "ttlMinutes must be <= 60", "details": { "issues": [] } } }
```

| HTTP | code |
|---|---|
| 400 | `validation_failed`, `token_malformed`, `token_bad_signature`, `invalid_token_type`, `tier_not_licensed`, `upload_incomplete`, `last_org_admin` |
| 401 | `unauthenticated`, `invalid_credentials`, `invite_invalid`, `reauth_required` |
| 403 | `forbidden`, `csrf_failed` |
| 404 | `not_found`, `token_not_found` |
| 409 | `email_taken`, `slug_taken`, `token_busy`, `already_ended`, `recording_exists` |
| 410 | `token_gone` (`details.status`: `used` \| `revoked` \| `expired`), `link_expired` |
| 413 | `payload_too_large` |
| 421 | `region_mismatch` (`details.region`, `details.origin: string \| null`) |
| 429 | `rate_limited` (`details.retryAfterSec`) |
| 500 | `internal` |

`token_bad_signature` is `400` (a malformed credential, not an authentication challenge) so a shared client never confuses it with "not logged in". `token_expired` no longer exists; expiry is `410 token_gone` with `details.status = 'expired'` everywhere (REST and WS). Validation uses zod schemas exported from `@indiansassist/shared` (`api/*.ts`); `details.issues` is `ZodError.issues`. Shared exports `ApiErrorCode` union and `ApiError` type.

### 6.3 Shared response objects

| Object | Shape |
|---|---|
| `User` | `{ id, orgId, email, name, role, status, createdAt, lastLoginAt }` |
| `Org` | `{ id, name, slug, dataRegion, planTier, branding: { displayName?, logoData?, accentColor?, supportEmail? }, createdAt }` |
| `Seat` | `{ id, userId, tier, active }` |
| `Token` | `{ id, tier, typ, status, shortCode, shortCodeDisplay, label, region, createdBy: { id, name }, issuedAt, expiresAt, usedAt, revokedAt, deniedCount, joinUrl, joinHost }` (`joinHost` = the host of `WEB_ORIGIN`, shown next to the code per T5; the QR is rendered client side from `joinUrl`) |
| `Session` | `{ id, tokenId, tokenCreatedBy: { id, name }, assist: { id, name }, deskLabel, tier, state, consentState, consentSurface, path, region, nodeId, knockedAt, acceptedAt, consentAt, startedAt, endedAt, endReason, lastStats, recordingStarted, recordingId, hashChainTail }` (`assist` is the accepting user) |
| `AuditEntry` | `{ id, seq, sessionId, actor: { type, id, label }, action, reason, region, ts, data, prevHash, hash }` |
| `Recording` | `{ id, sessionId, status, mime, bytes, sha256, durationMs, storageKey, chainedInto, region, createdAt, storedAt }` |
| `Page<T>` | `{ items: T[], nextCursor: string \| null }`; query `limit` (default 50, max 200) and `cursor`. **The cursor is opaque per endpoint** (the web treats it as a black box and echoes it verbatim); it is base64url of the sort key of the last item of the page: tokens and sessions `<createdAt ISO>\|<id>` (ordered `created_at desc, id desc`), users `<createdAt ISO>\|<id>` (ordered `created_at asc, id asc`), audit `<seq>` (ordered `seq desc`) |
| `ResidencyReport` | `{ org: { id, name, slug, dataRegion }, generatedAt, servedBy: { region, apiOrigin, nodeId }, storage: { driver, bucket, prefix }, ice: { stunUrls: string[], turnUrls: string[], thirdPartyHosts: string[] }, counts: { users, tokens, sessions, recordings, recordingBytes, auditEntries }, chain: { length, tail, lastVerifiedAt, lastVerifiedOk, lastAnchor: { seq, tail, ts, kid } \| null }, retention: { auditEntries: 'append-only, never deleted', piiInChain: 'hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)', recordings: 'until deleted by an org_admin (Phase B endpoint)' }, statement }` where `prefix = "<region>/<orgId>/"`, `bucket` is `S3_BUCKET` or `STORAGE_FS_DIR`, `thirdPartyHosts` lists any STUN/TURN host that is not under the deployment's own domain (`ICE_OWN_HOST_SUFFIXES`, section 11.1), and `statement` is "All session metadata, recordings and audit entries for <name> are stored and served in <region label>." followed by "Media candidates may be sent to third-party STUN hosts: <list>." when `thirdPartyHosts` is non-empty |

### 6.4 Health and discovery

| Method / path | Auth | Response |
|---|---|---|
| `GET /api/v1/health` | none | `200 { ok: true, region, servedRegions: Region[], nodeId, version, time }` |
| `GET /.well-known/indiansassist.json` | none | section 3.4 |
| `GET /metrics` | none, separate listener `METRICS_PORT` | Prometheus text format |

### 6.5 Auth

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `POST /api/v1/auth/signup` | none | `{ orgName, slug?, region?, name, email, password }` | `201 { user: User, org: Org, seat: Seat }` + cookie. Region check first (R5, `421` before anything is created). Creates org (`data_region = region ?? DEFAULT_REGION`, `audit_pepper`), user `org_admin` `active`, seat `p1_browser`. Audit `auth.signup`. `slug` defaults to slugified `orgName`, numeric suffix on conflict; explicit duplicate => `409 slug_taken`. |
| `POST /api/v1/auth/login` | none | `{ email, password }` | `200 { user, org, seat: Seat \| null }` + cookie. Audit `auth.login`. Failure `401 invalid_credentials` (same answer for unknown email, wrong password, `disabled` or `invited` user, or an email that lives in another region) and a `login_attempt` row; audit `auth.login_failed { userId }` **only** when the email resolved to a local user. Lockout per section 6.1. |
| `POST /api/v1/auth/logout` | any | none | `204`, cookie cleared, `auth_session.revoked_at` set. Audit `auth.logout`. |
| `GET /api/v1/auth/me` | any | none | `200 { user, org, seat: Seat \| null }` |
| `POST /api/v1/auth/accept-invite` | none | `{ invite: string, name, password }` | `200 { user, org, seat }` + cookie. Requires a user with `status = invited`, `invite_token_hash = sha256Hex(invite)` (constant-time) and `invite_expires_at > now()`; otherwise `401 invite_invalid`. On success: sets `password_hash`, `name`, `status = active`, **nulls `invite_token_hash` and `invite_expires_at`** (single use), mints a new session, audit `auth.login { method: 'invite' }`. |
| `POST /api/v1/auth/password` | any | `{ currentPassword, newPassword }` | `204`. Wrong current password => `401 reauth_required`. Revokes every other `auth_session` of the user. Audit `auth.password_changed`. Password reset by email is deferred (section 14). |

### 6.6 Orgs and users

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/orgs/current` | any | | `200 Org` |
| `PATCH /api/v1/orgs/current/branding` | org_admin | `{ displayName?, logoData?, accentColor?, supportEmail? }` (`accentColor` `^#[0-9a-fA-F]{6}$`; `logoData` **only** `data:image/png;base64,` or `data:image/jpeg;base64,` max 200 KiB decoded, validated by magic bytes; external URLs are rejected with `400 validation_failed` so the Desk's consent page never fetches a third-party host; `null` clears a field) | `200 Org`. Audit `org.branding_updated`. |
| `GET /api/v1/orgs/current/residency` | org_admin, auditor | | `200 ResidencyReport` |
| `GET /api/v1/users` | senior_technician, org_admin, auditor | `?limit&cursor` | `200 Page<User & { seat: Seat \| null }>` ordered `created_at asc, id asc` |
| `POST /api/v1/users/invite` | org_admin | `{ email, name, role, tier? }` | `201 { user: User, inviteUrl }` (`inviteUrl = ${WEB_ORIGIN}/invite#i=<secret>`; secret 32 bytes base64url, 7 days). `tier` must satisfy section 2.4. Creates seat with `tier` (default `p1_browser`) when the role has a seat. Audit `user.invited`. No email is sent in Phase A; the URL is returned in the response **only** (never logged; the log line carries the new user id). |
| `PATCH /api/v1/users/:id/role` | org_admin | `{ role, tier? }` | `200 User`. Demoting the last `org_admin` => `400 last_org_admin`. Creates, updates or removes the seat as needed (section 2.4). Audit `user.role_changed`. |
| `PATCH /api/v1/users/:id/status` | org_admin | `{ status: 'active' \| 'disabled' }` | `200 User`. Disabling the last active `org_admin` => `400 last_org_admin`. `disabled`: sets `auth_session.revoked_at` on all the user's sessions, revokes every `active` token created by the user (audit `token.revoked { reason: 'user_disabled' }` each; non-ended sessions on them end with `token_revoked`), closes the user's Assist sockets with `4401`. `active` re-enables login only. Audit `user.status_changed`. |

### 6.7 Tokens

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `POST /api/v1/tokens` | technician, senior_technician, org_admin | `{ tier: PackageTier, typ: TokenType, ttlMinutes?: int, ttlDays?: int, label?: string }` (refinement in section 3.2) | `201 { token: Token, compact: string, joinUrl: string }`. `compact` is returned only here. Audit `token.created`. |
| `GET /api/v1/tokens` | technician (own), senior_technician, org_admin, auditor | `?status=active\|used\|revoked\|expired&limit&cursor` | `200 Page<Token>` newest first. The filter and the reported `status` both use the **effective status** `CASE WHEN status = 'active' AND expires_at <= now() THEN 'expired' ELSE status END`, so `status=active` excludes lazily-expired rows and `status=expired` includes them. |
| `GET /api/v1/tokens/:id` | same scope | | `200 Token` |
| `POST /api/v1/tokens/:id/revoke` | technician (own), senior_technician, org_admin | none | `200 Token` with `status = revoked`; any non-ended session on it ends with `token_revoked` (both sides receive `session.ended`, section 7.3). Audit `token.revoked { reason: 'manual' }`. Already revoked => `200` idempotent, no second audit entry. |
| `POST /api/v1/tokens/public-lookup` | none (CSRF header still required) | `{ code: string }`, `code` = compact token or 12-digit short code (the JSON body keeps the bearer out of URLs and logs; the `GET /tokens/:code/public` route of revision 1 does not exist) | `200 PublicToken` / `400 token_malformed` / `400 token_bad_signature` / `404 token_not_found` / `410 token_gone` / `421 region_mismatch` / `429 rate_limited` |

`PublicToken` (never includes the compact string or the short code):

```json
{ "tokenId": "<uuid>", "tier": "p1_browser", "typ": "one_time", "expiresAt": "...", "region": "in-mum",
  "org": { "displayName": "Acme IT", "logoData": null, "accentColor": "#0f766e", "supportEmail": null },
  "technician": { "name": "Priya S" }, "signalUrl": "ws://localhost:4000/signal", "joinSupported": true }
```

`joinSupported` is `true` only for `p1_browser`. `org.displayName` falls back to `org.name`. `technician` is `null` when the lookup was by short code (section 3.3 S4).

### 6.8 Sessions

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/sessions` | technician (own), others org | `?state=&from=&to=&limit&cursor` (`from` / `to` ISO 8601 datetimes, half-open `[from, to)`, filter on `knocked_at`) | `200 Page<Session>` newest first |
| `GET /api/v1/sessions/stats` | same | `?from=&to=` (same format, default last 30 days) | `200 { total, active, byPath: { p2p, relay, unknown }, byEndReason: Record<SessionEndReason, number>, avgDurationMs, medianRttMs, byDay: [{ day: 'YYYY-MM-DD', count }] }`; `byDay` buckets in UTC; sessions that never reached `active` are excluded from `avgDurationMs` |
| `GET /api/v1/sessions/:id` | same | | `200 Session & { participants: [{ role, label, userId, connectionId, joinedAt, leftAt }], files: SessionFile[] }` where `SessionFile = { fileId, direction, name, bytes, assistSha256, deskSha256, match: boolean \| null }` (`match` null until both sides reported) |
| `POST /api/v1/sessions/:id/end` | technician (own), senior_technician, org_admin | `{ note?: string }` (stored in `reason`) | `200 Session`; pushes `session.ended` on WS to both sides; `409 already_ended`. Audit `session.ended` with `endReason = assist_ended`. |
| `POST /api/v1/sessions/:id/events` | assist of the session | `{ action: 'file.sent' \| 'file.received' \| 'recording.started', data }` with `data = { fileId, direction, name, bytes, sha256 }` for `file.*` and `{}` for `recording.started` | `201 AuditEntry`. The only client-reported REST audit actions; rejected (`409 already_ended`) after `ended_at + 60 s`. `recording.started` is deduplicated: a second call answers `200` with the existing entry, writes nothing; the first call sets `session.recording_started = true` and pushes `session.recording { recording: true }` to the Desk over WS. `file.*` upserts the `session_file` row (`assist_sha256`, `assist_entry_id`) and writes the entry with `nameHash`. |

PRD 11 lists `POST /sessions` (REST accept). Phase A performs accept and deny over WS only (`assist.accept` / `assist.deny`, section 7.3) because the acceptor needs the live socket for `session.created`; `POST /api/v1/sessions/:id/accept` and `/deny` are reserved for the Phase B mobile controller (section 15).

### 6.9 Audit

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/sessions/:id/audit` | session scope (not observer) | | `200 { items: AuditEntry[], integrity: { ok: boolean, checked: number, verifiedAt, failure?: VerifyFailure }, files: SessionFile[] }`. `items` ordered by seq asc, all entries of the session, no paging. `integrity` is computed server side on request: for every listed entry recompute `hashAuditEntry` and compare with `hash`, and check `prev_hash` equals the hash of the entry's actual predecessor in the org chain (`seq - 1`, fetched by seq); a session's entries are a non-contiguous subset of the org chain, so `verifyChain` is **not** run on them. `files` flags attestation mismatches (`match: false`). |
| `GET /api/v1/audit` | senior_technician, org_admin, auditor | `?action=&sessionId=&from=&to=&limit&cursor` (`from` / `to` ISO datetimes, half-open, filter on `ts`) | `200 Page<AuditEntry>` seq desc, cursor `<seq>` |
| `POST /api/v1/audit/export` | org_admin, auditor | `{ from?, to? }` (ISO datetimes, half-open, on `ts`) | `200 application/x-ndjson` (section 5.5), `Content-Disposition: attachment; filename="..."`. The web triggers it with `fetch` and saves the blob. A `kind = export` checkpoint is written before the body streams; audit `audit.exported { fromSeq, toSeq }` is written after the export is computed (not part of the file). `POST` because the call has a side effect and GET is CSRF-exempt. |
| `POST /api/v1/audit/verify` | org_admin, auditor | none | `200 { ok, checked, tail, failure?, verifiedAt }`. Runs section 5.4 over the whole org chain with the latest checkpoint; writes a `kind = verify` checkpoint carrying the result; audit `audit.verified`. |
| `GET /api/v1/audit/verify` | same | | the latest `kind = verify` checkpoint of this org as `{ ok, checked, tail, failure?, verifiedAt } \| null` (persisted, section 5.6 C4) |

### 6.10 Recordings

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `POST /api/v1/sessions/:id/recordings` | assist of session | multipart (`@fastify/multipart`): field `meta` (JSON string `{ mime, durationMs? }`) then field `file`. Body limit 100 MiB (`413 payload_too_large`). | `201 Recording` (status `stored`). Audit `recording.stored`. A `stored` row => `409 recording_exists`; a `failed` row, or an `uploading` row older than 1 h, is **reused** (same `recordingId` and `storageKey`, status reset to `uploading`, stale parts deleted). |
| `POST /api/v1/sessions/:id/recordings/uploads` | same | `{ mime, durationMs?, bytes }` (`bytes` <= 2 GiB, else `413 payload_too_large`) | `201 { uploadId, recordingId, partSize: 16777216, parts: ceil(bytes / partSize) }`; same reuse rule as above; `upload_expires_at = now + 24 h` |
| `PUT /api/v1/recordings/uploads/:uploadId/parts/:n` | same | raw body `application/octet-stream`, `n` from 1 to `parts` (else `400 validation_failed`), body limit 16 MiB; every part except the last must be exactly `partSize` bytes and the last `bytes - (parts - 1) * partSize`; idempotent by `n` | `200 { n, bytes }` |
| `POST /api/v1/recordings/uploads/:uploadId/complete` | same | `{ parts: int }` (must equal the declared `parts`) | `200 Recording`; `400 upload_incomplete` with `details.missing: number[]`; the concatenated size must equal the declared `bytes` else `400 validation_failed`. Audit `recording.stored`. |
| `GET /api/v1/recordings/:id` | session scope (not observer) | | `200 Recording` |
| `GET /api/v1/recordings/:id/download` | session scope (not observer) | | `200 { url, expiresAt }` (presigned, 600 s) |
| `GET /api/v1/recordings/:id/file` | signed URL only (`?exp=&sig=`), no cookie needed | | streams the object with `Content-Type` and `Content-Length`; used by the `fs` driver's presign. `sig` = hex `HMAC-SHA256(presignKey, id + ':' + key + ':' + exp)` with `presignKey = HKDF-SHA256(SESSION_COOKIE_SECRET, salt = '', info = 'ia-presign', 32 bytes)` (section 10.1); constant-time compare. Bad or missing `sig` => `404 not_found` (no oracle); valid `sig` with `exp < now` => `410 link_expired`. |
| `POST /api/v1/recordings/:id/verify` | session scope (not observer) | | `200 { ok, sha256, expectedSha256, chainSha256, bytes, chainedInto }` re-hashes the stored object |

### 6.11 ICE

`GET /api/v1/ice?sessionId=` (technician roles; `sessionId` optional, when present the caller must be the Assist of that session), the `iceServers` field of `session.created` (**Assist side only**), `consent.ok` (Desk, on the `active` transition), `assist.reconnected` (Desk, when active) and `ice.refresh` (both) use the same builder `buildIceServers(principal)`:

```json
{ "iceServers": [
    { "urls": ["stun:turn.in-mum.indianscloud.com:3478"] },
    { "urls": ["turn:turn.in-mum.indianscloud.com:3478?transport=udp", "turn:turn.in-mum.indianscloud.com:3478?transport=tcp", "turns:turn.in-mum.indianscloud.com:5349"], "username": "1761220000:user:<uuid>", "credential": "<base64 hmac>" }
  ], "iceTtl": 3600, "iceExpiresAt": "2026-10-23T11:15:30.000Z" }
```

| Rule |
|---|
| `username = "<expiry>:<principal>"`; `expiry` = unix seconds `now + iceTtl`; `principal` = `user:<userId>` for Assist, `desk:<sessionId>` for the Desk |
| `credential = base64(HMAC-SHA1(key = TURN_SECRET, message = username))` (coturn `use-auth-secret` + `static-auth-secret=TURN_SECRET`) |
| `iceTtl` = env `TURN_TTL_SECONDS` (default 3600); the field is named `iceTtl` everywhere (REST and WS) |
| **The Desk receives TURN credentials only once the session is `active`** (in `consent.ok`), never in `session.created`, so a token holder who is accepted but declines, or never consents, never obtains relay credentials. The Assist's credentials arrive in `session.created` (the Assist is an authenticated user). |
| **Refresh.** While a session is `active`, the server sends `ice.refresh { sessionId, iceServers, iceTtl, iceExpiresAt }` to both sides at 80 % of `iceTtl` after the last credential it issued to that side; the receiver calls `pc.setConfiguration({ ...config, iceServers })` then `pc.restartIce()` (the impolite side, the Desk, triggers the renegotiation; the Assist only applies the configuration and waits for the offer). coturn re-validates the timestamp on allocation refresh, so without this a relayed session longer than `iceTtl` would drop. |
| `GET /api/v1/ice` is rate limited to 10 / minute per user (section 6.12) |
| STUN entry from `STUN_URLS`, TURN entry from `TURN_URLS` (comma lists); when `TURN_URLS` is empty the TURN entry is omitted; when both are empty `iceServers` is `[]` (host candidates only, fine on a LAN) |

### 6.12 Rate limits

HTTP limits use `@fastify/rate-limit` keyed on the resolved client IP (`TRUST_PROXY`); WS and per-key limits use the api's own sliding-window limiter `apps/api/src/limiter.ts` (`memory` or `redis`, following `PRESENCE_DRIVER`), because `@fastify/rate-limit` does not see WS frames. All limits are disabled when `RATE_LIMIT_DISABLED=true` (tests).

| Scope | Key | Limit |
|---|---|---|
| `POST /auth/login`, `/auth/signup`, `/auth/accept-invite`, `/auth/password` | IP | 10 / minute |
| `POST /auth/login` | email hash | lockout per section 6.1 |
| `POST /tokens/public-lookup`, WS `desk.hello` | IP | 30 / minute |
| short-code misses | node | 300 / 60 s sliding, then 5 minutes of `429` for short codes (section 3.3 S3) |
| `GET /ice` | user | 10 / minute |
| WS upgrade to `/signal` | IP | 60 / minute, and at most 20 concurrent sockets per IP that have not completed `hello` |
| WS frames | connection | token bucket 20 frames / s, burst 60; excess => `error rate_limited`; third violation within a minute => close `4429` |
| WS `desk.knock` | token | 5 / 10 minutes |
| WS `session.stats` | session | dropped silently when < 4 s since the previous accepted one |
| everything else authenticated | IP | 600 / minute |

### 6.13 `/download` and `/join`

The API serves no HTML. The web app serves `/join#t=<compact>` and `/download#t=<compact>` (redirect to `/join`). Both routes render `<meta name="referrer" content="no-referrer">` (also the `/room/*` routes). Join page behaviour (PRD section 6):

| Step | Behaviour |
|---|---|
| 1 | On load read `t` from `location.hash` (fallback: `location.search` for compatibility), keep it in memory, and immediately `history.replaceState(null, '', '/join')` so the token leaves the URL bar, history entry and any `Referer`. If present call `POST /api/v1/tokens/public-lookup { code }`. Show org branding, technician name (or "your technician" when `technician` is null), tier, expiry countdown. |
| 2 | If `t` is absent, or the lookup fails with `400` (`token_malformed`, `token_bad_signature`: "This link is not a valid IndiansAssist link") or `404` ("This code is not valid, has already been used, or belongs to another region; use the full link or ask your technician for a new code"), show the manual field "Paste your support code or link" accepting the 12-digit code, the full token, or a full join URL (the page extracts `t` from the fragment or query); **Continue** repeats the lookup. `410` shows "This link has expired / was already used / was revoked" by `details.status` plus the manual field. `421` follows `details.origin` only under the R3 allow-list rule, else shows the region message. `429` shows "Too many attempts, try again in <retryAfterSec> s"; `5xx` and network errors show "Could not reach the server" with **Retry**. |
| 3 | Primary button for `p1_browser`: **Join support session**. On click: `navigator.clipboard.writeText(compact)` (best effort, failures ignored), store the compact token in `sessionStorage['ia.join.token']` and `PublicToken.signalUrl` in `sessionStorage['ia.join.signal']`, navigate to `/room/new`. When the Desk came with a short code, the room uses the short code as `token`. The Desk connects the WS to `PublicToken.signalUrl`; `VITE_API_URL` is used only for the initial REST call. |
| 4 | Secondary button **Copy token again**: writes the compact token (or short code) to the clipboard and shows "Copied" for 2 s. Present on the join page and on the room's waiting screen. |
| 5 | Tiers other than `p1_browser`: show "The IndiansAssist client for this package is not available yet" plus the copy button (stub for later tiers). |
| 6 | `/room/new` with no `sessionStorage['ia.join.token']` (new tab, crash, bookmark) redirects to `/join` with no token, which shows the manual field. |

---

## 7. WebSocket signaling `/signal`

Same origin and port as the API (`ws://localhost:4000/signal` in dev; `wss://<WEB_ORIGIN host>/signal` through nginx in production), library `ws` attached to the Fastify server. Text frames only, each one JSON object.

### 7.1 Envelope

```json
{ "t": "desk.knock", "id": "c1", "deskLabel": "Rahul" }
```

| Field | Rule |
|---|---|
| `t` | message type, required |
| `id` | optional client-chosen correlation id; a reply carries `re: <id>` |
| `ts` | when present, integer ms since epoch (conventions table) |
| other | payload fields at top level (no nested `payload`) |

Unknown `t` => `error unknown_type`. Max frame 64 KiB (`error payload_too_large`, connection kept). Shared exports zod schemas per message and the `SignalMessage` discriminated union keyed on `t`; every `t` has exactly one shape (hence `assist.hello.ok` / `desk.hello.ok` and `session.end` / `session.ended` below).

### 7.2 Connection, auth and authorisation

| Side | How |
|---|---|
| Assist | cookie `ia_session` on the upgrade request; `Origin` must equal `WEB_ORIGIN`; role must have "WS as Assist" (section 2.3). On failure the upgrade is rejected with HTTP 401 / 403. After upgrade the client sends `assist.hello` within 5 s. |
| Desk | upgrade is anonymous (`Origin` check still applies); the first frame must be `desk.hello { token }` within 5 s where `token` is the compact token or the 12-digit code; the server runs section 3.5. On failure the server sends `error` (with `details` where section 3.5 defines them) then closes with code `4403`. |
| Both | **Heartbeat (binding):** the server sends `{ t: 'ping' }` every 25 s and the client **must** answer `{ t: 'pong' }` within 10 s. The server's idle timer counts any inbound frame (including `pong`); a connection with no inbound frame for 60 s is closed `4408`. Browsers do not auto-answer JSON pings, so a client that ignores them is closed after 60 s. Clients may also send `ping` and receive `pong` (used for the displayed signaling latency). WebSocket protocol-level pings are not used. |
| Both | Upgrade limits per section 6.12: 60 upgrades / minute per IP and at most 20 sockets per IP that have not completed `hello`. |

**Session authorisation (binding, applies to every message that carries `sessionId`):** a message is accepted only when the sending socket is the connection currently registered as the `assist` or the `desk` participant of that session (connection-id match, held in the server's session registry; **not** an org match and **not** a role match). Registration happens at `assist.accept` (the accepting socket), `knock.ok` (the Desk socket), `assist.resume` (after the `user.id === session.assist_user_id` check) and a `desk.hello` with a valid `resumeKey`. Any other socket, including another technician or an org_admin of the same org, receives `error forbidden` (the message is not relayed, nothing changes) and the attempt is logged at `warn`; when the sender is an authenticated Assist, audit `signal.forbidden` is also written. `assist.resume` by a user other than `session.assist_user_id` is `error forbidden` in Phase A (supervisor join is deferred). `assist.accept` / `assist.deny` are authorised by the matrix row "knock accept / deny" (own tokens, or any token in the org for `senior_technician` / `org_admin`), evaluated against the knock's token; the socket must also have received that knock (be subscribed to it).

Close codes: `1000` normal, `4401` unauthenticated (also used when the user is disabled mid-session), `4403` token invalid / forbidden / `join_unsupported`, `4408` hello or heartbeat timeout, `4409` token busy (another Desk is live on this token), `4410` session ended, `4429` rate limited.

Each connection gets a server `connectionId` (uuid). The Desk's **first** connection id becomes `session.desk_ref`; later Desk connections (resume) get their own `session_participant` row but `desk_ref` never changes, so `actor.id` of desk audit entries is stable across one session.

### 7.3 Message catalogue

Direction: `A->S` Assist to server, `S->A`, `D->S` Desk to server, `S->D`. `D<->S<->A` means relayed to the other participant of the same session (after the authorisation rule above).

| `t` | Dir | Payload | Notes |
|---|---|---|---|
| `assist.hello` | A->S | `{}` | reply `assist.hello.ok { connectionId, user: { id, name, role }, region }`. Subscribes the socket to knocks on the user's own tokens; `org_admin` and `senior_technician` are also subscribed to every knock in the org (the server deduplicates by `sessionId`, so a creator who is also admin gets each knock once). **Replay:** right after `assist.hello.ok` the server sends `assist.knock` for every session in state `knocked` the socket is subscribed to, then performs held knocks (section 7.5). |
| `desk.hello` | D->S | `{ token: string, deskLabel?: string, resumeKey?: string }` | reply `desk.hello.ok { connectionId, tokenId, tier, technician: { name } \| null, org: { displayName, accentColor, logoData }, region, resume?: { sessionId, state, consentState } }`. `technician` is the token creator and is `null` when `token` was a short code (S4); the waiting screen shows "Waiting for <technician>" or "Waiting for your technician". `resume` is present when `resumeKey` matched (constant-time) a non-ended session on this token; the resume path then follows section 7.5. `deskLabel` here is the fallback for `desk.knock.deskLabel`. |
| `desk.poll` | D->S | `{}` | reply `poll.status { state: 'waiting' \| 'held' \| 'matched', sessionId?, sessionState?, technicianOnline: boolean }`. `held` = a knock is requested and waits for a technician (section 7.5); `matched` once a session on this token is `accepted` or later. Desk polls every 3 s while `waiting` / `held` (belt and braces beside the push messages) and the poll refreshes the presence TTL. |
| `desk.knock` | D->S | `{ deskLabel?: string }` | when at least one subscribed Assist socket that may act on this token is online: creates `session` (state `knocked`, `node_id`, `knock_expires_at`), writes `session.knock`, registers the socket as the Desk participant; reply `knock.ok { sessionId, resumeKey, expiresAt }`. When none is online: **no session row**, reply `knock.held { technicianOnline: false }` and the knock is held in presence (section 7.5). Error `token_busy` when a non-ended session already exists on the token; `rate_limited` beyond 5 knocks / 10 min per token. |
| `knock.held` | S->D | `{ technicianOnline: false }` | reply to `desk.knock` when no eligible Assist is online |
| `token.presence` | S->A | `{ tokenId, waiting: boolean, held: boolean }` | a Desk connected with this token (hello ok) or left before knocking; `held` when a knock is waiting for a technician |
| `assist.knock` | S->A | `{ sessionId, tokenId, tokenLabel, tokenCreatedBy: { id, name }, deskLabel, userAgent, knockedAt, expiresAt, canAct: boolean }` | sent to every subscribed Assist socket; `expiresAt = knockedAt + 120 s`; `canAct` is `true` when this user may accept / deny per the matrix (creator, or senior / admin) so the web renders Accept / Deny only when it will succeed |
| `assist.accept` | A->S | `{ sessionId }` | authorisation per section 7.2; `knocked -> accepted`, `session.assist_user_id = accepting user`, `token.denied_count = 0`; writes `session.accepted { tokenId, onBehalfOf }`; registers the socket as the Assist participant; reply is `session.created` (to both sides); other subscribed sockets get `knock.closed { sessionId, by: 'accepted', acceptedBy: { id, name } }`. The token stays `active` (a `one_time` token becomes `used` on the `active` transition, section 3.2). |
| `assist.deny` | A->S | `{ sessionId, reason?: string, revokeToken?: boolean }` | authorisation per section 7.2; `-> ended (denied)`; `token.denied_count += 1`; writes `session.denied`, `session.ended`; Desk gets `session.ended { endReason: 'denied' }` **and its socket stays open** (it may knock again); others get `knock.closed { sessionId, by: 'denied' }`. `revokeToken: true`, or `denied_count` reaching 3, revokes the token (`token.revoked { reason: 'manual' \| 'auto_denied' }`, actor user / system) and the Desk socket is then closed `4403`. The deny toast offers **Deny** and **Deny and revoke token**. |
| `knock.closed` | S->A | `{ sessionId, by: 'accepted' \| 'denied' \| 'timeout' \| 'ended' \| 'revoked', acceptedBy?: { id, name } }` | removes the toast on every other subscribed socket |
| `session.created` | S->A, S->D | `{ sessionId, tokenId, tier, state, consentState, assist: { id, name }, desk: { label }, org: { displayName, accentColor, logoData }, polite: boolean, iceServers?, iceTtl?, iceExpiresAt? }` | `assist` is the **accepting** user (the Desk consent screen renders this name, never `desk.hello.ok.technician`). `polite` is `true` for the Assist, `false` for the Desk. `iceServers` / `iceTtl` / `iceExpiresAt` are present **only on the Assist copy**. On first send (after accept) the state becomes `consent_pending` (`consent_deadline_at` set) and `state: 'consent_pending'`, `consentState: 'pending'` are sent. When re-sent for a resume it carries the **real** `state` and `consentState` and causes **no transition**. |
| `desk.consent` | D->S | `{ state: 'granted' \| 'revoked', surface?: 'monitor' \| 'window' \| 'browser' \| 'unknown' }` | `granted` (only in `consent_pending`, else `error bad_state`): `consent_pending -> active`, `started_at` set if null, `one_time` token `-> used`, writes `session.consent_granted` then `session.started`; reply `consent.ok` with the Desk's ICE servers. `revoked`: `-> ended (consent_revoked)`, writes `session.consent_revoked`, `session.ended`; reply `consent.ok { state: 'ended' }` then `session.ended`. |
| `consent.ok` | S->D | `{ sessionId, state, consentState, iceServers?, iceTtl?, iceExpiresAt? }` | reply to `desk.consent`; ICE fields present when `state === 'active'`. Only after this reply does the Desk build its `RTCPeerConnection` (section 7.7). |
| `consent.changed` | S->A | `{ sessionId, state, surface? }` | mirror to the Assist; `granted` also means "session is active, expect an offer" |
| `webrtc.offer` | D<->S<->A | `{ sessionId, sdp: string }` | relayed verbatim to the other participant; dropped with `error consent_required` unless state is `active` |
| `webrtc.answer` | D<->S<->A | `{ sessionId, sdp: string }` | same gate |
| `webrtc.ice` | D<->S<->A | `{ sessionId, candidate: RTCIceCandidateInit \| null }` | same gate |
| `chat.message` | D<->S<->A | `{ sessionId, msgId, from: 'assist' \| 'desk', text (max 4000), ts }` | relay fallback while `ia.chat` is not open. **Allowed only while the session is `active`** and until the Assist has sent `chat.channel_open` (then `error relay_closed`). **The server overwrites `from` with the sending socket's role** and ignores the client value. The server never logs or persists `text`; it only increments the `chat.relayed` counter. This relay is the known Phase A E2EE gap (section 15). |
| `chat.channel_open` | A->S | `{ sessionId }` | the Assist reports `ia.chat` open; the server stops relaying chat for this session |
| `session.stats` | A->S | `{ sessionId, path: 'p2p' \| 'relay' \| 'unknown', rttMs, codec, bitrateKbps, fps, width, height, packetsLost, ts }` | at most every 5 s (server drops frames < 4 s apart); stored in `session.last_stats`; a `path` change updates `session.path` and writes `session.path_changed` |
| `desk.event` | D->S | `{ sessionId, action: 'file.sent' \| 'file.received', data: { fileId, direction, name, bytes, sha256 } }` | the Desk's attestation of a transfer (section 8.3); writes the `file.*` entry with actor `desk`, upserts `session_file` (`desk_sha256`, `desk_entry_id`); accepted until `ended_at + 60 s`; reply `event.ok { sessionId, entryId }` |
| `session.recording` | S->D | `{ sessionId, recording: boolean }` | pushed when the server receives `recording.started` (section 6.8) so the Desk banner does not depend on the console alone (D3) |
| `ice.refresh` | S->A, S->D | `{ sessionId, iceServers, iceTtl, iceExpiresAt }` | section 6.11 refresh rule |
| `desk.reconnected` | S->A | `{ sessionId, state, consentState }` | Desk re-attached with `resumeKey`; section 7.5 says what the Assist does |
| `assist.resume` | A->S | `{ sessionId }` | re-attach the Assist socket to a live session after reload; `user.id` must equal `session.assist_user_id` (else `error forbidden`); reply `session.created` with the real `state` / `consentState` and fresh Assist ICE servers; writes `session.resumed { side: 'assist' }`; Desk gets `assist.reconnected` |
| `assist.reconnected` | S->D | `{ sessionId, state, iceServers?, iceTtl?, iceExpiresAt? }` | the Assist re-attached; ICE fields present when `state === 'active'`; section 7.5 says what the Desk does |
| `session.end` | A->S, D->S | `{ sessionId, note?: string }` | client request. Assist => `assist_ended`; Desk => `desk_stopped`; `note` is stored in `reason` (sanitised, 500); writes `session.ended`; both sides then receive `session.ended` |
| `session.ended` | S->A, S->D | `{ sessionId, endReason: SessionEndReason, endedAt, startedAt, durationMs, hashChainTail, assist: { id, name }, surface, recordingStarted: boolean, reachedActive: boolean }` | server push to **both** sides on every transition to `ended`. `hashChainTail` is `session.hash_chain_tail` after the `session.ended` entry (a later `recording.stored` moves it; the receipt says "chain tail at session end"). After sending, the server closes the Desk socket with `4410` except for `endReason` `denied` or `timeout`-before-accept, where the socket stays open so the Desk can knock again; the Assist socket always stays open. |
| `error` | S->* | `{ re?, code, message, details? }` | codes: `unknown_type`, `bad_payload`, `not_authenticated`, `forbidden`, `token_malformed`, `token_bad_signature`, `token_not_found`, `token_gone` (`details.status`), `region_mismatch` (`details.region`, `details.origin`), `token_busy`, `join_unsupported`, `session_not_found`, `bad_state`, `consent_required`, `relay_closed`, `payload_too_large`, `rate_limited` (`details.retryAfterSec`) |
| `ping` / `pong` | both | `{}` | section 7.2 heartbeat |

`resumeKey`: 32 random bytes base64url returned at knock; stored hashed in `session.resume_key_hash`; compared constant-time. Without a valid `resumeKey`, a `desk.hello` on a token with a live session answers `error token_busy` and closes `4409`.

Naming is uniform across sections: `tokenId` on every wire object except the signed payload (`tid`), `tier` (never `package`), `iceTtl`, `endReason` on the push, `note` on the client request.

### 7.4 Session state machine

| From | Event | To | Triggered by | Audit written |
|---|---|---|---|---|
| (token_waiting) | `desk.knock`, eligible Assist online | `knocked` | Desk | `session.knock` |
| (token_waiting) | `desk.knock`, nobody online | (token_waiting, knock held) | Desk | none |
| (knock held) | eligible Assist `assist.hello` | `knocked` | server on the Desk's behalf | `session.knock` |
| `knocked` | `assist.accept` | `accepted`, then `consent_pending` as `session.created` is sent | Assist (authorised acceptor) | `session.accepted` |
| `knocked` | `assist.deny` | `ended (denied)` | Assist | `session.denied`, `session.ended` (+ `token.revoked` on auto-revoke) |
| `knocked` | `knock_expires_at` passed (120 s) | `ended (timeout)` | sweeper / owner node | `session.ended` |
| `consent_pending` | `desk.consent granted` | `active` | Desk | `session.consent_granted`, `session.started` |
| `consent_pending` | `desk.consent revoked` | `ended (consent_revoked)` | Desk | `session.consent_revoked`, `session.ended` |
| `consent_pending` | Desk leaves past grace | `ended (desk_left)` | server | `session.ended` |
| `consent_pending` | `consent_deadline_at` passed (180 s) | `ended (timeout)` | sweeper / owner node | `session.ended` |
| `active` | Desk resume (`desk.hello` + `resumeKey`) | `consent_pending` (consent must be given again; the capture track is gone) | server | `session.resumed { side: 'desk', fromState: 'active', toState: 'consent_pending' }` |
| `accepted` / `consent_pending` | Desk or Assist resume | unchanged | server | `session.resumed` |
| `active` | Assist resume | unchanged | server | `session.resumed { side: 'assist' }` |
| `active` | `desk.consent revoked` | `ended (consent_revoked)` | Desk | `session.consent_revoked`, `session.ended` |
| `active` | `session.end` | `ended (assist_ended \| desk_stopped)` | either | `session.ended` |
| `active` | socket loss past grace | `ended (desk_left \| error)` | server | `session.ended` |
| any non-ended | token revoked / `POST /sessions/:id/end` / user disabled | `ended (token_revoked \| assist_ended)` | Assist or admin | `session.ended` |
| any non-ended | owner node lost (section 7.6) | `ended (error)` | sweeper | `session.ended` |

`token_waiting` is a presence state (a Desk is connected with the token, no session row yet). It is not an audit event. `chat.relayed` (when count > 0) is written immediately before every `session.ended`.

**Hard rule 1 (media gate):** no `webrtc.offer`, `webrtc.answer` or `webrtc.ice` is relayed unless the session is `active`, which requires the Assist to have accepted AND the Desk to have granted consent. The server drops the frame and answers `error consent_required`; it never buffers SDP.

**Hard rule 2 (teardown):** on **any** transition to `ended`, whether initiated locally or learned from `session.ended`, **both** sides must `track.stop()` every local track (screen and microphone), close every data channel, call `pc.close()` and discard the connection **before** rendering the receipt or the ended view. The Desk performs this teardown **before** sending `desk.consent { state: 'revoked' }` or `session.end`, so revocation is effective even if the socket is slow. The Assist stops `MediaRecorder` (keeping the recorded chunks for upload), sends nothing further on `ia.ctrl` and discards `recording.state` on the same event. Media is peer to peer; a server-side `ended` state does nothing to a stream, so this rule is what makes `consent_revoked` true.

### 7.5 Held knocks, timeouts and resume

**Held knocks (technician offline).** PRD 6.6 has the Desk wait until the technician is there, so a knock does not create a session when nobody can act on it. "Eligible Assist online" = at least one Assist socket subscribed to this token with `canAct = true`. When `desk.knock` finds none, the server records `knockRequested` on the token's presence entry, answers `knock.held`, and the Desk stays in `token_waiting` (polling, TTL refreshed). When an eligible Assist completes `assist.hello`, the server performs the knock on behalf of every held Desk on the user's tokens (creates the session, writes `session.knock`, sends `knock.ok` to the Desk and `assist.knock` to the Assist). The 120 s knock timer therefore only runs while somebody can see the toast.

**Timeout before accept.** `knocked -> ended (timeout)` sends `session.ended { endReason: 'timeout', reachedActive: false }` to the Desk but keeps the Desk socket open; the room shows "Your technician did not answer" with **Try again** (a new `desk.knock`, subject to the per-token knock limit). The consent receipt (D6) is shown only for sessions with `reachedActive: true`; others show a plain ended view.

**Desk resume** (`desk.hello` with a valid `resumeKey`, inside the 30 s grace or any time before the session ends): steps 1-6 and 8 of section 3.5 still run; step 7 accepts `used` (section 3.5). The server closes the old `session_participant` desk row, opens a new one with the new `connectionId`, registers the socket, and:

| Session state at resume | Server does | Desk does | Assist does on `desk.reconnected` |
|---|---|---|---|
| `knocked` | re-send nothing beyond `desk.hello.ok.resume`; Desk returns to the waiting screen | wait | nothing (toast still open) |
| `accepted` / `consent_pending` | re-send `session.created` to the Desk (real state) | show the consent screen (D1) | nothing |
| `active` | `active -> consent_pending`, `consent_state = pending`, `consent_surface` kept, `consent_deadline_at` reset, audit `session.resumed`, re-send `session.created` to the Desk, send `desk.reconnected { state: 'consent_pending' }` to the Assist | close any old `RTCPeerConnection`, show the consent screen again; D2 applies (a reload loses the `getDisplayMedia` track and the browser requires a fresh gesture) | hard rule 2 teardown of its `RTCPeerConnection`; stop `MediaRecorder` if running (the Record button is then disabled: one recording per session in Phase A); show "Waiting for consent" again |

**Assist resume** (`assist.resume`): server checks `user.id === session.assist_user_id`, closes / opens the `session_participant` assist row, registers the socket, writes `session.resumed { side: 'assist' }`, replies `session.created` with the real `state` / `consentState` and fresh Assist ICE servers, and sends `assist.reconnected` to the Desk. On `assist.reconnected` with `state === 'active'` the Desk tears down its old `RTCPeerConnection` (hard rule 2 minus stopping the capture track), creates a new one with the ICE servers in the message, re-adds the existing screen (and microphone) track, re-creates the four data channels and sends a fresh `webrtc.offer`. In any other state the Desk only updates its view.

**Disconnect handling:** Desk socket closes while state is not `ended` => 30 s grace for resume, then `ended (desk_left)`. Assist socket closes => 30 s grace for `assist.resume`, then `ended (error)`. Knock not accepted within 120 s => `timeout`. Consent not granted within 180 s of the latest `session.created` => `timeout`.

### 7.6 Multi-node ownership and sweeper

| # | Rule |
|---|---|
| N1 | Every API node has `NODE_ID` (env; default `<hostname>:<pid>`). A session row stores the owner in `session.node_id` (the node holding the Desk and Assist sockets; updated on resume when a side reconnects to a different node, the sockets then being bridged over the `session:<id>` presence channel). |
| N2 | With the `redis` presence driver each node writes a heartbeat key `ia:node:<NODE_ID>` with TTL 90 s every 30 s. A node is *lost* when its key is absent. With the `memory` driver there is one node and it is lost whenever the process restarts. |
| N3 | **On boot a node closes only its own rows**: every non-ended session with `node_id = NODE_ID` ends with `ended (error)` (a restart of this node cannot have preserved sockets). It never touches rows owned by other nodes. |
| N4 | A 10 s sweeper on every node: ends `knocked` sessions with `knock_expires_at < now()` and `consent_pending` sessions with `consent_deadline_at < now()` as `timeout` (whichever node wins the row-level `UPDATE ... WHERE state = ...` writes the audit entry and publishes `session.ended` on `session:<id>`), ends non-ended sessions whose `node_id` is lost (N2) as `error`, deletes `login_attempt` rows older than 24 h, fails and cleans recordings whose `upload_expires_at` passed (section 9), and writes periodic checkpoints (section 5.6 C2). |
| N5 | Timer deadlines live on the row, never only in memory; in-memory timers are an optimisation that the sweeper backs up. |

### 7.7 WebRTC negotiation

| Rule |
|---|
| **Order of operations on the Desk (D2 is the single source of truth):** on **Share my screen** the Desk calls `getDisplayMedia(...)` first; when the picker resolves it sends `desk.consent { state: 'granted', surface }`; on `consent.ok { state: 'active', iceServers }` it creates the `RTCPeerConnection` with those ICE servers, adds the track, creates the four data channels (section 8) and sends the first `webrtc.offer`. If the picker is cancelled nothing is sent and the Desk stays on the consent screen; no `session.consent_granted` entry is ever written for a Desk that did not actually share. |
| `getDisplayMedia` options: `{ video: { frameRate: { ideal: 15, max: 30 } }, audio: false, surfaceSwitching: 'include', selfBrowserSurface: 'exclude', monitorTypeSurfaces: <'exclude' when the consent screen toggle "Share a single window instead of my whole screen" is on, else 'include'> }` (unknown options are ignored by browsers that lack them) |
| Both sides implement perfect negotiation; `polite` comes from `session.created` (Assist polite, Desk impolite) |
| Voice: each side adds its microphone track with `addTrack`; renegotiation uses the same offer / answer messages |
| `RTCPeerConnection` config: `{ iceServers, iceCandidatePoolSize: 2, bundlePolicy: 'max-bundle' }`; `iceTransportPolicy: 'all'` (the console network panel has a dev toggle for `'relay'`) |
| Trickle ICE on; `candidate: null` signals end of candidates |
| ICE refresh: on `ice.refresh` both sides call `pc.setConfiguration({ ...pc.getConfiguration(), iceServers })`; the Desk then calls `pc.restartIce()` (section 6.11) |
| Path detection (Assist, every 5 s via `getStats()`): nominated `candidate-pair` whose local or remote candidate has `candidateType === 'relay'` => `relay`, else `p2p`; no nominated pair yet => `unknown` |
| Teardown per hard rule 2 (section 7.4) |

---

## 8. WebRTC data channel protocol (Desk <-> Assist, not via server)

Channels are created by the Desk before the first offer with `ordered: true` and default reliability; the Assist receives them via `ondatachannel`. Text frames are JSON; only file chunks are binary (`ArrayBuffer`, `binaryType = 'arraybuffer'`).

| Label | Purpose |
|---|---|
| `ia.chat` | chat |
| `ia.annot` | annotation overlay |
| `ia.file` | file transfer |
| `ia.ctrl` | control signals |

Every JSON message has `t` and `ts` (ms since epoch, integer). Messages that can originate from either side carry `from: 'assist' | 'desk'`; the receiver ignores a `from` that does not match the channel's peer (the peer is known from the session). Annotation messages carry no `from` (Assist -> Desk only in Phase A) and use `a` / `b` for coordinates so the shared base schema `{ t, ts, from? }` holds. Shared exports zod schemas and the `DataChannelMessage` union.

### 8.1 Chat (`ia.chat`)

| `t` | Shape |
|---|---|
| `chat` | `{ t: 'chat', msgId: uuid, from, text (max 4000), ts }` |
| `chat.ack` | `{ t: 'chat.ack', msgId, ts }` |
| `typing` | `{ t: 'typing', from, active: boolean, ts }` |

A message carries the same `msgId` whether sent over the channel or relayed via WS `chat.message`; receivers de-duplicate on `msgId`. Senders use the data channel when `readyState === 'open'`, else the WS relay (only while the server still relays, section 7.3). When `ia.chat` opens, the Assist sends WS `chat.channel_open`.

### 8.2 Annotation (`ia.annot`), Assist -> Desk in Phase A

Coordinates are normalised floats `0..1` relative to the shared video frame's intrinsic size (`videoWidth`, `videoHeight`), origin top-left. **The Desk renders annotations over a local preview of its own captured `MediaStream`** (the Desk holds the track) so coordinates stay frame-relative for every `surface`: in Chromium the preview opens in a `documentPictureInPicture` window (always on top, small, draggable) and elsewhere it is a floating in-page preview panel in the room tab. Mapping annotations onto the Desk's page viewport is wrong for `monitor` and `window` shares and is not done. The Assist also draws them over its remote view so both see the same picture. (PRD 3 P1 says "the Desk sees it as an overlay"; the preview-window rendering is the Phase A reading of that sentence, recorded in section 15.)

| `shape` | Shape |
|---|---|
| `arrow` | `{ t: 'annot', id: uuid, shape: 'arrow', a: { x, y }, b: { x, y }, color: '#rrggbb', ttlMs, ts }` |
| `rect` | `{ t: 'annot', id, shape: 'rect', a: { x, y }, b: { x, y }, color, ttlMs, ts }` |
| `highlight` | `{ t: 'annot', id, shape: 'highlight', a, b, color, ttlMs, ts }` (filled, 30 % alpha) |
| `pointer` | `{ t: 'annot', id, shape: 'pointer', at: { x, y }, color, ts }` (moves the single pointer; no ttl) |
| `clear` | `{ t: 'annot', shape: 'clear', ts }` (removes everything including the pointer) |

Default colour `#f59e0b`; `ttlMs` default 8000, max 60000. Numbers are rounded to 4 decimals.

### 8.3 File transfer (`ia.file`), both directions

| `t` | Shape |
|---|---|
| `file.offer` | `{ t: 'file.offer', fileId: uint32, name (sanitised, max 200), size, mime, sha256, chunkSize: 16384, chunks: ceil(size / 16384), ts }` |
| `file.accept` | `{ t: 'file.accept', fileId, ts }` |
| `file.reject` | `{ t: 'file.reject', fileId, reason: 'declined' \| 'too_large' \| 'busy' \| 'bad_name', ts }` |
| chunk | **binary frame**: bytes `[0,4)` uint32 big-endian `fileId`, `[4,8)` uint32 big-endian `chunkIndex` (0-based), `[8, 8+n)` payload, `n <= 16384` (only the last chunk may be shorter) |
| `file.done` | `{ t: 'file.done', fileId, ts }` |
| `file.ack` | `{ t: 'file.ack', fileId, ok: boolean, sha256, ts }` receiver recomputed sha256 over the reassembled bytes |
| `file.cancel` | `{ t: 'file.cancel', fileId, reason?: 'aborted' \| 'bad_chunk' \| 'overflow' \| 'hash_mismatch', ts }` either side |

Rules:

| # | Rule |
|---|---|
| F1 | `fileId` is a per-sender counter starting at 1 (ids may repeat across directions); one transfer per direction at a time (`busy`) |
| F2 | **Max size 256 MiB in Phase A** (reassembled in memory; `too_large` otherwise). Streaming to disk via the File System Access API with a higher cap is deferred (section 14). |
| F3 | The sender waits while `bufferedAmount > 1048576` (`bufferedAmountLowThreshold = 262144`); sha256 via `crypto.subtle.digest('SHA-256')` on the whole file before offering |
| F4 | **Receiver rules:** reject a chunk with `chunkIndex >= chunks`, a duplicate `chunkIndex`, a chunk for an unknown or unaccepted `fileId`, a non-final chunk shorter than `chunkSize`, or cumulative bytes `> size`; each rejection sends `file.cancel` with the reason and frees the buffers. After `file.done` the receiver requires every chunk present and total bytes `=== size`, then hashes. |
| F5 | **`name` is sanitised by both sides** with shared `sanitiseFileName(name, fileId): string`: NFC-normalise; remove C0 / C1 / DEL controls and the bidi and zero-width characters of section 5.3; replace `/ \ : * ? " < > \|` with `_`; strip leading dots and whitespace; collapse runs of whitespace; truncate to 200 chars keeping the extension; reserved Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) get a `_` prefix; an empty result becomes `file-<fileId>`. The receiver re-sanitises the offered name before display and save; a name that changes under re-sanitisation is still accepted (the sanitised form is used) but an offer whose `name` is empty or longer than 255 is rejected with `bad_name`. |
| F6 | The accept dialog shows, separately: the sanitised name, the **extension** (last suffix, or "none"), the **declared MIME** and the **sniffed type** of the first 16 KiB after download (the dialog itself shows declared MIME; the sniffed type is shown on the save prompt), the size and the sender name. Extensions in `EXECUTABLE_EXTENSIONS` (shared: `exe com scr bat cmd ps1 psm1 vbs vbe js jse wsf wsh msi msp msc dll hta cpl jar reg lnk app pkg dmg sh command apk`) render a red warning "This file type can run programs on your computer" and the accept button needs a second click. |
| F7 | On `file.ack ok` the Assist reports `file.sent` / `file.received` via `POST /api/v1/sessions/:id/events` and the Desk reports the mirror action via WS `desk.event`, each with its own computed `sha256`, the sanitised `name`, `bytes`, `fileId` and `direction` (section 5.3); the server flags disagreement in `SessionFile.match`. |

### 8.4 Control (`ia.ctrl`)

| `t` | Dir | Shape |
|---|---|---|
| `stop.sharing` | Desk -> Assist | `{ t: 'stop.sharing', ts }` sent when the Desk clicks Stop or the browser's own "Stop sharing" fires (`track.onended`); the Desk then performs hard rule 2 and sends WS `session.end` |
| `consent.revoked` | Desk -> Assist | `{ t: 'consent.revoked', ts }` sent immediately before the Desk's hard rule 2 teardown and WS `desk.consent { state: 'revoked' }` |
| `recording.state` | Assist -> Desk | `{ t: 'recording.state', recording: boolean, ts }` the Desk banner shows a red dot while this **or** WS `session.recording` says true |
| `voice.state` | both | `{ t: 'voice.state', from, muted: boolean, ts }` |
| `ping` / `pong` | both | `{ t: 'ping', ts }` / `{ t: 'pong', ts }` used for the displayed RTT when `getStats` RTT is unavailable |

---

## 9. Recordings

| Step | Contract |
|---|---|
| Capture | The console renders the remote video through a `<canvas>` (section 12, watermark) and records `canvas.captureStream()` mixed with remote audio and the local microphone via `AudioContext` with `MediaRecorder`; `mimeType` preference `video/webm;codecs=vp9,opus`, then `video/webm;codecs=vp8,opus`, then `video/webm`; `timeslice` 1000 ms; parts kept in memory |
| Watermark | the canvas draws the remote frame and, on top, a repeating semi-transparent (18 % alpha) diagonal text `<assist name> <userId first 8> <sessionId first 8> <HH:mm:ss UTC>` refreshed every second, so both the live view and the stored recording carry the technician's identity (PRD 7 "technician watermark overlay for forensics") |
| Start | user clicks Record; Assist sends `recording.state { recording: true }` on `ia.ctrl` and `POST /sessions/:id/events { action: 'recording.started' }` (the server also pushes WS `session.recording` to the Desk). One recording per session in Phase A: after the recorder stops (user, session end or Desk resume) the button is disabled. |
| Upload (<= 100 MiB) | one `POST /api/v1/sessions/:id/recordings` multipart when recording stops or the session ends |
| Upload (> 100 MiB, <= 2 GiB) | `uploads` init with the exact `bytes`, `PUT` parts of 16 MiB in order, `complete`; the server concatenates parts in order into the final object, verifies the total equals `bytes`, and deletes the parts |
| Server | streams the body through sha256 while writing via `ObjectStorage.put`; sets `bytes`, `sha256`, `status = stored`, `stored_at`; writes audit `recording.stored` with `{ recordingId, sha256, bytes, mime, storageKey }`; sets `recording.chained_into` to that entry |
| Storage key | `<region>/<orgId>/<sessionId>/<recordingId>.webm` (parts: same key with `.part<n>` suffix) |
| Verify | `POST /recordings/:id/verify` re-reads the object through the adapter, re-hashes, compares with `recording.sha256` (`expectedSha256`) and with `data.sha256` of the `chained_into` audit entry (`chainSha256`); `ok` only if both match |
| Download | `GET /recordings/:id/download` returns `presignGet(key, 600)` |
| Failure | upload error => `status = failed`, audit `recording.failed`; the client may retry with the same `uploadId` (parts idempotent by `n`) or a fresh single upload, which reuses the row (section 6.10) |
| Expiry | an `uploading` row whose `upload_expires_at` (24 h) has passed is set to `failed` by the sweeper (audit `recording.failed { error: 'upload_expired' }`, actor system) and its `.part<n>` objects are deleted |
| Limits | max 2 GiB per recording; `413 payload_too_large` on init when `bytes` exceeds it |

---

## 10. Storage, presence and auth adapters

Interfaces live in `apps/api/src/adapters/`; the api package owns the implementations.

### 10.1 `ObjectStorage`

```ts
interface ObjectStorage {
  put(key: string, body: Readable | Uint8Array, opts: { contentType: string; contentLength?: number }): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<Readable>;                      // throws ObjectNotFoundError
  head(key: string): Promise<{ bytes: number; contentType: string; lastModified: Date } | null>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;                        // idempotent
}
```

| Driver (`STORAGE_DRIVER`) | Behaviour |
|---|---|
| `fs` (dev default) | root `STORAGE_FS_DIR` (`./data/storage`), key mapped to a path (keys are validated: no `..`); `presignGet` returns `${API_ORIGIN}/api/v1/recordings/<id>/file?exp=<unix>&sig=<hex>` with `sig = HMAC-SHA256(presignKey, id + ':' + key + ':' + exp)` and `presignKey = HKDF-SHA256(ikm = SESSION_COOKIE_SECRET, salt = '', info = 'ia-presign', length = 32)` (`crypto.hkdfSync`), so the cookie secret and the presign key rotate independently of each other's purpose; verification per section 6.10 |
| `s3` | `@aws-sdk/client-s3` with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`; one bucket per region cluster; `presignGet` via `@aws-sdk/s3-request-presigner` |

### 10.2 `Presence`

```ts
interface Presence {
  setTokenWaiting(tokenId: string, info: { connectionId: string; nodeId: string; knockRequested: boolean }, ttlSeconds: number): Promise<void>;
  clearTokenWaiting(tokenId: string, connectionId: string): Promise<void>;
  getTokenState(tokenId: string): Promise<{ waiting: { connectionId: string; nodeId: string; knockRequested: boolean } | null; sessionId: string | null }>;
  setTokenSession(tokenId: string, sessionId: string | null): Promise<void>;
  heartbeatNode(nodeId: string, ttlSeconds: number): Promise<void>;          // ia:node:<id>
  isNodeAlive(nodeId: string): Promise<boolean>;
  publish(channel: string, message: object): Promise<void>;
  subscribe(channel: string, handler: (message: object) => void): Promise<() => Promise<void>>; // returns unsubscribe
}
```

Channels: `org:<orgId>:knocks`, `session:<sessionId>`, `user:<userId>`. Drivers (`PRESENCE_DRIVER`): `memory` (dev default, single node; `publish` delivers to local subscribers synchronously; `isNodeAlive` is true only for the own node) and `redis` (`REDIS_URL`, `ioredis`, keys `ia:tok:<tokenId>` and `ia:node:<id>` with TTL, pub/sub on the same channel names). Token waiting TTL is 90 s, refreshed by `desk.poll`. The rate limiter of section 6.12 shares the driver choice (`memory` or `redis`).

### 10.3 `AuthProvider`

```ts
interface AuthProvider {
  readonly kind: 'local' | 'oidc';
  verifyPassword?(email: string, password: string): Promise<{ userId: string } | null>; // local
  hashPassword?(password: string): Promise<string>;                                       // local
  beginLogin?(redirectUri: string): Promise<{ url: string; state: string }>;              // oidc (Phase E)
  completeLogin?(params: Record<string, string>): Promise<{ email: string; subject: string; name: string }>; // oidc
}
```

`AUTH_PROVIDER=local` in Phase A; `oidc` is a stub whose methods throw `not_implemented` (Keycloak in Phase E). Cookie sessions (`auth_session`) are provider-independent.

---

## 11. Environment variables and infrastructure

### 11.1 `apps/api` (`.env` at repo root, loaded with `dotenv`; `infra/.env.example` documents all of them)

| Var | Dev default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on `Secure` cookies and makes the "prod: required" secrets mandatory (`src/config.ts` refuses to boot otherwise) |
| `PORT` | `4000` | HTTP + WS port |
| `METRICS_PORT` | `9464` | Prometheus listener; `0` disables it |
| `HOST` | `0.0.0.0` | bind address |
| `NODE_ID` | `<hostname>:<pid>` | session owner id (section 7.6) |
| `API_ORIGIN` | `http://localhost:4000` | public origin of this node (well-known, presign). Production: equal to `WEB_ORIGIN` (section 11.4) |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS, CSRF, cookie origin, join and invite links |
| `TRUST_PROXY` | `false` | Compose sets `true`; Fastify `trustProxy`, limiter keys on the resolved client IP |
| `DATABASE_URL` | `` (empty) | empty => PGlite at `PGLITE_DIR`; otherwise `postgres://user:pass@host:5432/db`. Production: the role must be `DB_APP_ROLE` |
| `MIGRATE_DATABASE_URL` | `` | owner-role connection used only by `migrate`; defaults to `DATABASE_URL` in dev |
| `PGLITE_DIR` | `./data/pglite` | PGlite data dir |
| `DB_APP_ROLE` | `` | when set, migrations revoke UPDATE / DELETE / TRUNCATE on `audit_entry` and `audit_checkpoint` from this role. **prod: required** |
| `SESSION_COOKIE_SECRET` | dev: auto-generated 32 bytes, persisted base64url to `./data/cookie.secret`; **prod: required (>= 32 chars)** | cookie signing; HKDF input for the presign key |
| `TOKEN_SIGNING_KEY` | dev: auto-generated 32-byte seed persisted as 64 hex chars to `./data/signing.key`; **prod: required** | Ed25519 seed (tokens and checkpoints) |
| `TOKEN_SIGNING_KEYS_PREVIOUS` | `` | comma list of retired **public** keys, base64url (43 chars each, same encoding as well-known `pub`), kept in well-known for verification |
| `DEFAULT_REGION` | `in-mum` | signup default and the `region` reported by `/health` |
| `SERVED_REGIONS` | `` (all) | comma list of regions this node serves; production: exactly one |
| `REGION_ORIGINS` | `in-mum=http://localhost:5173,eu-fra=http://localhost:5173,us-east=http://localhost:5173` | comma list `region=webOrigin` used in `421` responses; a region without an entry yields `origin: null` |
| `TURN_SECRET` | `dev-turn-secret` | coturn `static-auth-secret`. **prod: required (>= 32 chars) whenever `TURN_URLS` is non-empty**; boot is refused otherwise |
| `TURN_URLS` | `` | comma list, e.g. `turn:turn.in-mum.indianscloud.com:3478?transport=udp,turns:turn.in-mum.indianscloud.com:5349` |
| `STUN_URLS` | `` (empty: host candidates only, enough on a LAN) | comma list; `infra/.env.example` sets the Compose coturn URL; Google STUN appears only as a commented-out option (PRD principle 2: no mandatory third-party cloud) |
| `ICE_OWN_HOST_SUFFIXES` | host of `API_ORIGIN` | comma list of host suffixes considered first-party for `ResidencyReport.ice.thirdPartyHosts` |
| `TURN_TTL_SECONDS` | `3600` | TURN credential lifetime (`iceTtl`); refreshed in session per section 6.11 |
| `PRESENCE_DRIVER` | `memory` | `memory` \| `redis` (also selects the limiter backend) |
| `REDIS_URL` | `` | required when `redis` |
| `STORAGE_DRIVER` | `fs` | `fs` \| `s3` |
| `STORAGE_FS_DIR` | `./data/storage` | fs root |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `` | s3 driver (all required when `s3`) |
| `S3_FORCE_PATH_STYLE` | `true` | s3 driver |
| `AUTH_PROVIDER` | `local` | `local` \| `oidc` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | `` | Phase E |
| `LOG_LEVEL` | `info` | pino level (redaction list of section 6 applies at every level) |
| `RATE_LIMIT_DISABLED` | `false` | tests set `true` |

All `./data/*` paths are relative to the repo root and git-ignored (`data/` is already in `.gitignore`). The api must start with zero env vars set in development. Shared exports nothing about env; the api package has `src/config.ts` with a zod schema for the table above including the production refinements (`DB_APP_ROLE`, `SESSION_COOKIE_SECRET`, `TOKEN_SIGNING_KEY`, `TURN_SECRET` when `TURN_URLS`, `WEB_ORIGIN === API_ORIGIN`, `https:` origins, exactly one `SERVED_REGIONS`).

### 11.2 `apps/web` (Vite, `.env` in `apps/web`)

| Var | Dev default | Meaning |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | API origin; REST at `${VITE_API_URL}/api/v1`, Assist WS at `${VITE_API_URL.replace(/^http/, 'ws')}/signal`. The Desk WS uses `PublicToken.signalUrl` instead. Production builds set it to `WEB_ORIGIN` (same origin through nginx). |
| `VITE_REGION_ORIGINS` | `in-mum=http://localhost:5173,eu-fra=http://localhost:5173,us-east=http://localhost:5173` | compiled allow-list for following `421` redirects and for the `/login` region picker; a `421` origin not in this list is never followed; in production every entry must be `https:` |
| `VITE_APP_NAME` | `IndiansAssist` | shown in the title and the Desk banner |

### 11.3 Infra (Compose service names and ports)

| Service | Image | Ports | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | 5432 (internal only) | two roles: `ia_owner` (migrations) and `ia_app` (`DB_APP_ROLE`) |
| `valkey` | `valkey/valkey:8` | 6379 (internal only) | |
| `coturn` | `coturn/coturn:4.6` | 3478 udp + tcp, 5349 tcp (`turns:`), relay **49160-49200 udp (dev default; production uses `network_mode: host` with 49152-65535, see `infra/HARDENING.md`)** | config `infra/coturn/turnserver.conf` (section 11.5) |
| `seaweedfs` | `chrislusf/seaweedfs:3.80` (`server -s3 -dir=/data`) | 8333 (s3, internal only), 9333 master (internal) | Apache-2.0. Replaces the Garage default of revision 1: Garage is AGPL-3.0, the licence PRD 15.5 steers away from. Garage stays usable as an unmodified network service (documented in `docs/LICENSE-REGISTER.md`) but is not the default. |
| `api` | built from `apps/api` | 4000 and 9464 **not published on the host**; reached only through `web` | |
| `web` | built from `apps/web`, nginx | 80 (redirect to 443) / 443 | TLS termination and reverse proxy (section 11.4) |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | 8080 (internal), Compose profile `sso` (optional) | |

### 11.4 TLS, reverse proxy and security headers (binding; shipped as `infra/nginx/nginx.conf`)

| # | Rule |
|---|---|
| P1 | nginx terminates TLS for `WEB_ORIGIN` with `ssl_protocols TLSv1.2 TLSv1.3` (1.3 preferred; `ssl_prefer_server_ciphers off`, Mozilla "intermediate" cipher list), certificates from `infra/certs/` (Let's Encrypt or customer supplied); the same certificate and key are mounted into `coturn` for `turns:5349`. PRD 7 asks for TLS 1.3 everywhere; 1.2 remains enabled only for older Desk browsers and is listed as a hardening toggle. |
| P2 | nginx proxies `/api/` (plain HTTP, `proxy_http_version 1.1`), `/signal` (with `Upgrade` / `Connection` headers, `proxy_read_timeout 75s` and `proxy_send_timeout 75s`, both longer than the 60 s heartbeat idle timeout) and `/.well-known/indiansassist.json` to `api:4000`; everything else serves the SPA (`try_files $uri /index.html`). Therefore `WEB_ORIGIN === API_ORIGIN` in production and the api port is never published. |
| P3 | Response headers on every response: `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), geolocation=(), display-capture=(self), microphone=(self)`, and `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The SPA's `index.html` carries `<meta name="referrer" content="no-referrer">` as well, so the dev server behaves the same. |
| P4 | Access log format `'$remote_addr - [$time_local] "$request_method $uri" $status $body_bytes_sent'` (`$uri`, never `$request` or `$args`, so no query string is ever logged; the token travels in the fragment anyway). |
| P5 | `client_max_body_size 110m` for `/api/v1/sessions/*/recordings` and `17m` for `/api/v1/recordings/uploads/*/parts/*`; `1m` elsewhere. |
| P6 | `infra/HARDENING.md` (deliverable of the infra step) covers: TLS material and renewal, firewall ports (only 443 tcp, 3478 udp/tcp, 5349 tcp and the relay range are exposed), coturn production relay range and `network_mode: host`, Postgres roles, secret generation, log retention and the redaction guarantees, backup of Postgres and the object store per region, the `DB_APP_ROLE` requirement, and the residency checklist (one Compose stack per region). |

### 11.5 coturn configuration (binding; shipped as `infra/coturn/turnserver.conf`)

The container runs `turnserver -c /etc/coturn/turnserver.conf` with environment substitution of `${TURN_SECRET}`, `${TURN_REALM}` and `${TURN_EXTERNAL_IP}` at start. Directives:

| Directive | Value | Why |
|---|---|---|
| `listening-port` / `tls-listening-port` | `3478` / `5349` | section 6.11 URLs |
| `use-auth-secret`, `static-auth-secret=${TURN_SECRET}` | | TURN REST credentials (section 6.11) |
| `realm=${TURN_REALM}` | e.g. `turn.in-mum.indianscloud.com` | required for long-term credential mechanism |
| `fingerprint` | | RFC 5389 fingerprints |
| `cert` / `pkey` | the `web` certificate and key | `turns:5349` |
| `no-tlsv1`, `no-tlsv1_1` | | TLS 1.2+ only (PRD 7) |
| `no-cli` | | no admin CLI port (5766) |
| `no-multicast-peers` | | |
| `no-rfc5780`, `no-stun-backward-compatibility`, `response-origin-only-with-rfc5780` | | smaller STUN attack surface |
| `min-port=49160`, `max-port=49200` | dev; production 49152-65535 | relay range matches Compose |
| `denied-peer-ip` | `0.0.0.0-0.255.255.255`, `10.0.0.0-10.255.255.255`, `100.64.0.0-100.127.255.255`, `127.0.0.0-127.255.255.255`, `169.254.0.0-169.254.255.255`, `172.16.0.0-172.31.255.255`, `192.0.0.0-192.0.0.255`, `192.168.0.0-192.168.255.255`, `198.18.0.0-198.19.255.255`, `224.0.0.0-255.255.255.255`, `::1`, `fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`, `fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff`, `::ffff:0:0-::ffff:ffff:ffff` | **no relay into the Compose network or any private range** (TURN SSRF / pivot to postgres, valkey, seaweedfs, keycloak). `allowed-peer-ip` is added only for a documented, specific need. |
| `external-ip=${TURN_EXTERNAL_IP}` | public IP (or `public/private` pair) | NAT deployments |
| `total-quota=1200`, `user-quota=12`, `max-bps=0`, `bps-capacity=0` | | per-credential and global allocation caps (a `desk:<sessionId>` or `user:<id>` principal gets at most 12 allocations) |
| `stale-nonce=600` | | nonce rotation |
| `no-loopback-peers`, `no-software-attribute`, `secure-stun` | | |
| `log-file=stdout`, `no-stdout-log` unset, `verbose` off | | logs to the container; `simple-log` |
| `pidfile=/var/tmp/turnserver.pid`, `proc-user=turnserver`, `proc-group=turnserver` | | drop privileges |

Operational rule: the `TURN_SECRET` in the api env and `static-auth-secret` must be the same value; rotating it invalidates outstanding credentials, so rotate during a maintenance window or run two coturn instances during the overlap.

---

## 12. Web app routes

Single Vite + React app with React Router. Assist routes require a cookie session (`GET /auth/me` on boot, redirect to `/login` on its 401 only); Desk routes are public. All routes set `<meta name="referrer" content="no-referrer">`; Desk routes additionally never load any cross-origin resource (branding logos are `data:` URLs).

| Route | Who | Content |
|---|---|---|
| `/` | public | redirect: authenticated -> `/app`, else `/login` |
| `/signup` | public | org name, region select (default `in-mum`, labels from `REGION_LABELS`, helper text "Your data never leaves this region and this cannot be changed later"), name, email, password; a `421` follows the allow-listed origin (R3) |
| `/login` | public | email, password; region picker when `VITE_REGION_ORIGINS` has more than one distinct origin (section 1.1 T3), remembered in `localStorage['ia.region']` |
| `/invite` | public | reads `i` from the fragment (fallback query, then `replaceState`), accept invite: name, password |
| `/app` | Assist | dashboard: active sessions, recent sessions, quick "Create token", stats cards from `/sessions/stats` |
| `/app/tokens` | Assist | create token form (tier limited to seat tier, typ, lifetime, label); success panel with the join link, a client-rendered **QR code of `joinUrl`** (no server call), the short code and "valid on <joinHost>"; list with status badge, short code display `4821 9365 7710`, QR button, **Copy link** (join URL), **Copy token**, **Revoke**; live knock toasts from WS with **Accept** / **Deny** / **Deny and revoke token** rendered only when `assist.knock.canAct` is true (informational toast otherwise, showing who can act) |
| `/app/sessions` | Assist | list with state, path badge (`P2P` / `Relay`), duration, Desk label, acceptor name |
| `/app/sessions/:id` | Assist | console: remote video rendered through the watermark canvas (section 9), chat, voice toggle, file send / receive (section 8.3 dialog), annotation toolbar (arrow, rect, highlight, pointer, clear, colour), Record toggle, network panel (path, RTT, codec, bitrate, fps, resolution, packets lost), End session; on reload `assist.resume`; after end: session audit list with the `integrity` badge from `GET /sessions/:id/audit` and the org-level last verify result, file attestation table with mismatch flags, recording upload progress, recording verify button |
| `/app/audit` | per matrix | org audit list with filters, **Export JSONL** (`POST`, blob download), **Verify chain** showing `Verified <time>` or `Broken at seq N (<kind>)`, last anchor (`seq`, `kid`), and an offline verifier that accepts a JSONL file (reads the header, runs `verifyChain` in a worker) |
| `/app/residency` | org_admin, auditor | renders `ResidencyReport` as a one-page printable report including ICE hosts, third-party host warnings and the retention statements |
| `/app/users` | org_admin (read for senior / auditor) | invite, role and seat tier change, enable / disable |
| `/app/account` | any | change password |
| `/join` | Desk | section 6.13 |
| `/download` | Desk | redirects to `/join` preserving the fragment (or query) |
| `/room/new` | Desk | reads `sessionStorage['ia.join.token']` and `['ia.join.signal']` (missing => redirect to `/join`), connects WS to `signalUrl`, `desk.hello`, auto `desk.knock`, then navigates to `/room/:sessionId` on `knock.ok`; on `knock.held` stays on the waiting screen ("Your technician is not online yet, this page keeps trying"); the `resumeKey` is kept in `sessionStorage['ia.room.resume']` |
| `/room/:sessionId` | Desk | waiting screen ("Waiting for <technician> to accept" or "Waiting for your technician"), consent screen, sharing room (section 12.1), ended view with **Try again** after `denied` / `timeout`, receipt after a session that reached `active`; on reload re-sends `desk.hello` with the stored `resumeKey` (section 7.5) |

### 12.1 Desk consent and banner requirements (PRD section 7)

| # | Requirement |
|---|---|
| D1 | The consent screen appears only after `session.created` and shows: the **accepting technician's name from `session.created.assist.name`** (never `desk.hello.ok.technician`), org display name and logo (`logoData`), what will be shared ("your screen, a window or a tab, you choose in the next step"), what cannot happen ("the technician cannot control your mouse or keyboard"), a pre-share checklist with a required checkbox "I have closed or hidden anything private", a toggle "Share a single window instead of my whole screen" (section 7.7 `monitorTypeSurfaces`), and a tip on silencing notifications (Windows Focus Assist / macOS Do Not Disturb). **Limitation stated on the screen:** a web page cannot blur or hide the taskbar or notifications itself (PRD 12.16 "blur on share" is reduced to guidance plus the single-window option in P1; section 15). Buttons: **Share my screen** (primary) and **Decline**. |
| D2 | **Share my screen** calls `getDisplayMedia` first (options in section 7.7); `desk.consent { state: 'granted', surface }` is sent only after the browser picker resolves (`surface` from `track.getSettings().displaySurface`, else `unknown`); the peer connection is created only after `consent.ok`. Picker cancelled => stay on the consent screen, nothing sent. **Decline** sends `desk.consent { state: 'revoked' }`. D2 is the single source of truth for this ordering. |
| D3 | While sharing, a persistent banner is fixed to the top of the viewport, never hidden by scrolling, min height 44 px, text "You are sharing your screen with <technician> (<org>)" (technician = `session.created.assist.name`), a red dot plus "Recording" when either `recording.state` (data channel) or `session.recording` (WS) says true, a live timer, a button that opens the annotation preview panel, and a **Stop sharing** button always visible and keyboard reachable. |
| D4 | **Stop sharing** (or browser-native stop) performs the hard rule 2 teardown (stop all tracks, close channels, `pc.close()`), sends `stop.sharing` on `ia.ctrl` if the channel is still open, then WS `session.end`. |
| D5 | Revoking consent (**Revoke consent** in the banner menu) sends `consent.revoked` on `ia.ctrl`, performs the hard rule 2 teardown, then sends `desk.consent { state: 'revoked' }`. |
| D6 | On `session.ended` with `reachedActive: true` the Desk shows a **consent receipt**: technician (`session.ended.assist.name` and id, same source as D1), org, start and end time (`startedAt`, `endedAt`), duration (`durationMs`), surface shared, files sent / received (names, sizes and sha256 from local state, each marked "reported to the server" once `event.ok` arrived), whether a recording was made (`recordingStarted`), the session id and the audit chain tail at session end (`hashChainTail`), with **Download receipt (JSON)**. The receipt is built from local state plus the `session.ended` payload; no authenticated call is needed. Sessions that never reached `active` show the ended view, not a receipt. |
| D7 | Document title while sharing is prefixed `(Sharing) `; the favicon switches to the sharing variant. |
| D8 | Voice is opt-in on the Desk side via an unmute button, default muted; the Desk never receives camera video. |
| D9 | On any `session.ended`, or on `assist.reconnected` / Desk resume, the Desk applies hard rule 2 before changing screens. |

---

## 13. Non-functional

### 13.1 WCAG AA baseline (console and Desk room)

| # | Requirement |
|---|---|
| A1 | Every interactive control is a native `button`, `a`, `input`, `select` or has an explicit role, with a visible label or `aria-label`; icon-only buttons have `aria-label` |
| A2 | Full keyboard operability: tab order follows visual order, focus ring visible (no `outline: none` without a replacement), Escape closes dialogs, dialogs trap focus and restore it on close |
| A3 | Text contrast >= 4.5:1, UI component contrast >= 3:1, in light and dark themes; the branding accent colour is contrast-checked and falls back to the default when it fails |
| A4 | Live regions: knock toasts, chat arrivals and session state changes announced via `aria-live="polite"`; errors via `role="alert"` |
| A5 | Annotation toolbar and banner are keyboard reachable; the toolbar and **Clear** work without a pointer (drawing itself is pointer-only in Phase A) |
| A6 | The remote video has a text alternative describing state ("Remote screen, 1280 by 720, connected via relay") |
| A7 | Respects `prefers-reduced-motion`; nothing flashes more than 3 times per second |
| A8 | Target size >= 24 by 24 CSS px; banner **Stop sharing** >= 44 by 44 |
| A9 | Unique page titles, one `h1` per page, labelled form fields, inline errors linked with `aria-describedby` |

### 13.2 Measured targets (PRD section 13)

Phase A measures and displays; it does not yet enforce. The Assist console samples `getStats()` every 5 s and sends `session.stats`. Metrics are also exported on `/metrics` (section 6).

| Metric | Source (`RTCStatsReport`) | Target |
|---|---|---|
| RTT | nominated `candidate-pair` `currentRoundTripTime` x 1000 | P2P median < 100 ms on good links |
| Path | `candidate-pair` -> `local-candidate` / `remote-candidate` `candidateType` | relay only when P2P fails |
| Codec | video `inbound-rtp` -> `codec` `mimeType` | VP8 or VP9 |
| Bitrate | delta `bytesReceived` on video `inbound-rtp` / delta time, kbps | informational |
| FPS, resolution | `inbound-rtp` `framesPerSecond`, `frameWidth`, `frameHeight` | >= 10 fps at 720p on a good link |
| Packet loss | `inbound-rtp` `packetsLost` | informational |
| Time to first frame | from `consent.changed granted` to the first `loadeddata` on the Assist video | < 3 s on LAN |
| Signaling latency | WS `ping` -> `pong` | < 200 ms |

### 13.3 Two-browser manual smoke test

Run `pnpm dev` (api :4000, web :5173). Browser 1 = Assist (Chrome). Browser 2 = Desk (Chrome incognito or Edge, so cookies are separate).

| # | Step | Expected |
|---|---|---|
| 1 | Assist: `/signup` with org "Smoke Org", region India | lands on `/app`; `auth.signup` visible in `/app/audit` |
| 2 | Assist: `/app/tokens`, create `p1_browser` `one_time` 15 min | token row with 12-digit code and QR; **Copy link** copies `/join#t=ia1...` |
| 3 | Desk: open the copied link | join page shows "Smoke Org", technician name, countdown; the URL bar shows `/join` without the token |
| 4 | Desk: click **Join support session** | clipboard holds the token; room shows "Waiting for <technician>" |
| 5 | Assist: knock toast within 2 s | toast shows Desk label and token label; **Accept** / **Deny** |
| 6 | Assist: **Accept** | console opens `/app/sessions/:id` with "Waiting for consent"; Desk shows the consent screen naming the acceptor |
| 7 | Desk: **Share my screen**, pick a screen | banner appears; Assist sees watermarked video within 3 s; network panel shows path and codec |
| 8 | Both: send a chat message each way | messages appear once each, typing indicator works |
| 9 | Assist: draw an arrow and a rect, then clear | overlay shows in the Desk preview panel and on the Assist; clears on both |
| 10 | Assist: send a 5 MB file; Desk: send a 1 MB file | accept dialog shows extension and MIME; progress, sha256 ok, `file.sent` and `file.received` from both sides in the session audit with `match: true` |
| 11 | Both: enable voice | audio each way; mute toggles |
| 12 | Assist: Record for 20 s, stop | Desk banner shows the Recording dot while active; `recording.started` appears once in the session audit |
| 13 | Desk: **Stop sharing** | Desk receipt screen with technician, duration and chain tail; Assist console shows ended, upload progress, then recording `stored` |
| 14 | Assist: open the session audit | ordered entries from `session.knock` to `recording.stored`; integrity badge green |
| 15 | Assist: `/app/audit` **Export JSONL**, then **Verify chain** | file downloads with a header line; verify `ok: true`; an `audit.anchored` entry appears |
| 16 | Assist: recording **Verify** | `ok: true`, sha256 matches the audit entry |
| 17 | Desk: reopen the same link | join page shows "already used" (`410 token_gone`) |
| 18 | Assist: create a `timed` token; Desk joins by typing the 12-digit code | same flow succeeds (consent screen still names the acceptor; waiting screen says "your technician"); after end, a second Desk join on the same code succeeds until expiry |
| 19 | Assist: `/app/residency` | report shows `in-mum`, counts match, chain tail equals the last audit hash, last anchor present |
| 20 | Repeat 3 to 7 with `TURN_URLS` empty on the same LAN, then with the console's `relay` dev toggle and coturn running | path `p2p` first, then `relay` |
| 21 | During an active share, reload the Desk tab | Desk returns to the consent screen; Assist shows "Waiting for consent"; after **Share my screen** video resumes; audit shows `session.resumed` |
| 22 | During an active share, reload the Assist tab | console reconnects via `assist.resume`; video resumes within 3 s without Desk action |
| 23 | Desk: knock while the Assist tab is closed; then open the Assist dashboard | Desk shows "not online yet"; toast appears when the dashboard loads; no `session.ended (timeout)` entries were written meanwhile |
| 24 | Assist: **Deny** three times on a fresh token | third deny revokes the token (`token.revoked { reason: 'auto_denied' }`), Desk socket closes |

---

## 14. Deferred (not Phase A)

| Item | Phase |
|---|---|
| Server-side pion recorder (also the only way to detect out-of-band recording by a modified console; Phase A relies on the console's `recording.started` report plus the server push) | A.2 |
| Supervisor join (`supervisor` participant, `session.supervisor_joined`) and session handoff | A.2 |
| OIDC / Keycloak end to end, SAML | E |
| PSA integrations (`integration` rows exist, no endpoints) | E |
| Enrollment tokens joining, `device` writes, P2-P4 clients | B-D |
| Email delivery for invites, consent receipts and password reset | B |
| `POST /api/v1/sessions/:id/accept` and `/deny` (REST acceptance for a mobile controller or PSA) | B |
| `GET /api/v1/download?t=` per-download stub (PRD 6.3 / 11) | C |
| `indiansassist://join?t=` protocol handler (PRD 6 one-time deep link) | C |
| QR scan in the phone app and NFC (PRD 6 "QR and NFC for mobile"); the dashboard QR itself ships in Phase A | C (Android) |
| File transfer streaming to disk (File System Access API) above the 256 MiB in-memory cap | B |
| Recording deletion endpoint and retention policies | B |
| Per-org pepper destruction (erasure) endpoint and DPDP erasure workflow | E |
| Global login directory (`auth/locate`); Phase A uses the client-side region picker | reconsidered in E |
| Password reset by email | B |

---

## 15. PRD deviations, amendments and extra Phase A deliverables

PLAN 6 says "amend the PRD, do not drift from it silently". This section is the list the PRD owner applies to PRD.md.

| # | PRD text | Phase A position | Why |
|---|---|---|---|
| X1 | PRD 11 `POST /sessions` "open a session (admin confirms the knock)" | Accept / deny happen over WS (`assist.accept` / `assist.deny`); REST equivalents reserved for Phase B | the acceptor needs the live socket for `session.created`; section 6.8 |
| X2 | PRD 3 P1 "Assist side annotation ... the Desk sees it as an overlay" | The Desk sees the overlay on a local preview of its own captured stream (PiP window or in-page panel), not over its page viewport | only a frame-relative canvas is correct for `monitor` and `window` shares; section 8.2 |
| X3 | PRD 12.16 "Blur on share ... pre blur notifications and the taskbar" | In P1 this is a checklist tip plus the "single window" option; a web page cannot blur the OS taskbar | browser sandbox; section 12.1 D1. Real blur arrives with the P3 agent |
| X4 | PRD 6 "Short lived by default ... minutes" vs revision 1's 24 h `timed` maximum | `timed` maximum is 480 minutes | section 3.2 |
| X5 | PRD 6.6 "polls periodically until it connects to that token's admin" | Implemented as held knocks: no session or audit entry until a technician who can act is online | section 7.5 |
| X6 | PRD 15.5 lists Garage among permissive stores | Garage is AGPL-3.0; Compose default is SeaweedFS (Apache-2.0); Garage remains an unmodified-network-service option | section 11.3; `docs/LICENSE-REGISTER.md` updated |
| X7 | PRD 7 "the relay never holds plaintext" | WS chat relay (`chat.message`) carries plaintext through the signaling server while `ia.chat` is not yet open during `active`; never logged or persisted, and closed by `chat.channel_open` | known Phase A E2EE gap; section 7.3 |
| X8 | PRD 6.2 "A token is bound to the admin" and PRD 2 Supervisor persona | A knock on a technician's token may be accepted by that technician, a `senior_technician` or an `org_admin`; the Desk is always shown the acceptor's name and the chain records `onBehalfOf` | section 2.3 / 7.3 |
| X9 | PRD 6 "Admin sees the knock" and the consent screen | The consent screen names the acceptor (`session.created.assist.name`), not the token creator | consent integrity; D1 |
| X10 | PRD 7 "technician watermark overlay for forensics" | Shipped in Phase A on the Assist view and burned into the recording | section 9 |
| X11 | ADR 0001 token payload (eight fields, three segments) | Ten fields, four segments (`kid` segment) | section 3.1; ADR amended |

Extra Phase A deliverables introduced by this revision (owners in brackets): `infra/coturn/turnserver.conf` and `infra/nginx/nginx.conf` per sections 11.4-11.5 and `infra/HARDENING.md` [infra]; `docs/LICENSE-REGISTER.md` kept current with every runtime dependency and Compose image and its licence, reviewed at the end of every phase [whoever adds a dependency]; `GET /metrics` [api]; the JSONL offline verifier in the web app [web]; the round-trip hash tests [shared, db].
