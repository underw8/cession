# cession threat model

Status: draft for the external security audit and penetration test. Reviewed against `main` at `643bbd5`, 2026-10-19.

## Scope

In scope:

- The Cloudflare Worker in `server/` (router, CSRF check, session gate, security headers) and its single Durable Object `Hub` (SQLite state, WebSocket broadcast, alarm).
- Authentication: passkeys (WebAuthn), the `SETUP_CODE` bootstrap, browser and widget session cookies, machine bearer tokens, widget pairing codes, device login (RFC 8628).
- The dashboard pages in `server/public/` (inline scripts, rendering of ingested strings).
- The Claude Code plugin: `plugin/hooks/report.sh` and `plugin/skills/setup/*.sh`, including how the token is stored and sent.
- The macOS widget (`widget/`): the Tauri webview, the local pairing page, cookie storage.

Out of scope:

- Cloudflare's own platform (Workers runtime, Durable Object storage encryption, TLS termination, the rate limiting binding). We rely on them as documented.
- Claude Code itself and Anthropic's OTel exporter.
- The security of the owner's laptops beyond the cession token file. A fully compromised machine can read every Claude Code session on it anyway.
- Denial of service against Cloudflare's network. Application-level resource exhaustion is in scope.

## System

A single-owner, self-hosted deployment: one person deploys their own Worker. There are no tenants and no other users.

```mermaid
flowchart LR
  M[Machine: report.sh, OTel exporter] -- Bearer machine token --> I[POST /events, /v1/metrics]
  B[Browser] -- passkey, cookie --> A[/auth/*, /api/*, /live]
  W[Widget webview] -- widget cookie --> A
  I --> H[(Hub Durable Object, SQLite)]
  A --> H
  B -- approves device code --> H
  M -- device login poll --> A
```

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Project metadata | `sessions`: working directory paths, git branch names, machine hostnames, session ids, timestamps | Reveals client and project names, repository layout, working hours. This is the main confidentiality concern. |
| Usage and cost | `usage_daily`, session usage columns | Spend and token counts per project. |
| Machine tokens | `machine_tokens.hash` (SHA-256), plaintext only on the machine in `~/.config/cession/token` or `CESSION_TOKEN` | Holder can write fake events and usage. Cannot read anything. |
| Session cookies | `auth_sessions.hash`, plaintext in the `__Host-cession` cookie | Browser session can read everything and manage devices; widget session can only read. |
| Passkeys | `passkeys` (public key, counter) | Root of trust; removing one removes everything it created. |
| `SETUP_CODE` | Worker secret | Registers a passkey without signing in. Equivalent to full account takeover. |
| Availability | One Durable Object instance | Everything stops if the Hub is overloaded or its storage fills up. |

Prompt text and tool input never leave the machine (`report.sh` sends only the fields it lists).

## Actors

| Actor | Starting position |
|---|---|
| Internet stranger | Knows or guesses the `*.workers.dev` URL. No credentials. |
| Malicious website | The owner visits it while signed in to the dashboard. |
| Holder of a leaked machine token | Token copied from a laptop, a dotfiles repo, CI logs or shell history. |
| Holder of a stolen widget cookie | Read access to the widget's cookie store. |
| Holder of a stolen browser cookie | Cookie taken from the owner's browser profile, without the passkey. |
| Device-code phisher | Starts a device login and convinces the owner to approve the code. |
| Process on a monitored machine | Same-user code on a laptop running the plugin (for example a malicious npm postinstall script). |
| Writer of ingested strings | Anyone who controls a directory name, branch name or hostname that ends up in an event. That includes a cloned repository. |

## Trust boundaries

1. Internet to Worker (all routes). TLS by Cloudflare; HSTS on https.
2. Machine to ingest routes (`/events`, `/v1/metrics`): bearer token, runs before the CSRF check and session gate.
3. Unauthenticated auth routes (`/auth/*`, `/auth/pair`, `/auth/device*`): rate limited at 60/min per client prefix, plus per-prefix lockouts in the Hub.
4. Session gate: browser scope versus widget scope (`WIDGET_PATHS`).
5. Hub storage to dashboard DOM: ingested strings are rendered in the browser and in the widget.
6. Owner's machine filesystem to plugin scripts (token file, `~/.claude/settings.json`).
7. Widget webview to the Worker origin.

## Threats

Severity: **High** blocks the pen test sign-off if open. **Medium** is fixed before the test or explicitly accepted. **Low** goes to the backlog.

| ID | Boundary | STRIDE | Asset | Actor | Impact | Severity | Mitigation or acceptance |
|---|---|---|---|---|---|---|---|
| T1 | 3 | Spoofing | `SETUP_CODE` | Internet stranger | Guessing it registers an attacker passkey: full read and device management. | High | Minimum 32 characters enforced at runtime. Per-prefix lockout (10 per /64, 100 per /48, 10-minute window) in one synchronous Hub step (`trySetupCode`). AUTH_LIMITER ahead of the Hub. Test: brute force, IPv6 prefix rotation. |
| T2 | 3 | Spoofing | Session cookies | Internet stranger | Guessing a widget pairing code yields a widget (read-only) session. | Medium | 8 characters from 31 symbols, single use, 10-minute TTL, per-prefix lockout in `redeemPairingCode`. |
| T3 | 3 | Spoofing | Machine tokens | Device-code phisher | Owner approves an attacker's device code; attacker gets a machine token (write only). | Medium | Fixed: approving a device code (`POST /api/device/approve`) needs a fresh user-verified assertion from a registered passkey, consuming a single-use login challenge; the issued token descends from the passkey that signed it and is written only while that passkey still exists. Approval page still shows the requesting machine name and raw IP; codes expire after 10 minutes; machine tokens cannot read data, but enable T5 and T6. Open: the device page still pre-fills the code from the link, so an owner who approves blindly with their passkey still issues a write-only token. |
| T4 | 3 | Denial of service | Availability | Internet stranger | Flooding `/auth/device` or `/auth/login/options` fills `device_codes` or `challenges`. | Medium | Per-prefix budget via `claimAttempt`, AUTH_LIMITER, expired rows deleted on each insert. Test: distributed sources and IPv6 prefix rotation. |
| T5 | 2 | Tampering | Usage and cost, project metadata | Holder of a leaked machine token | Forges sessions, statuses and cost; inflates history; fills storage. | Medium | Token is revocable per machine in `/devices`. Field length caps in `parseEvent` and `parseOtlp`. Timestamps more than 5 minutes ahead are rejected. Open: a token can write to any session id it knows (session ids are only visible behind the gate), and one OTLP body can create thousands of sessions. A large snapshot can exceed the WebSocket message size limit and freeze the dashboard. Fix: cap live sessions and points per request, and bind each session to the token that created it. |
| T6 | 2 | Denial of service | Availability | Holder of a leaked machine token | Large or high-rate OTLP bodies exhaust Hub CPU or storage. | Medium | Request size is bounded by the Workers platform limit. Retry dedupe keeps one hour of body digests. There is no per-token rate limit on ingest. Test this. |
| T7 | 5 | Tampering, elevation | Session cookies, project metadata | Writer of ingested strings | A directory or branch name containing HTML executes script in the dashboard (stored XSS). The script can then call browser-only APIs: mint machine tokens, revoke passkeys. | High | Pages must insert ingested strings as text, never as HTML. CSP blocks external script sources and cross-origin connections. Code review found every server-supplied string escaped (`esc()` or `textContent`). CSP still allows `'unsafe-inline'` scripts, so a future escaping miss becomes script execution; per-response nonces would close that. Primary test target. |
| T8 | 1 | Tampering | Device management | Malicious website | Cross-site POST or DELETE to `/api/*` (CSRF). | Medium | `SameSite=Lax` cookie is not sent on cross-site POST or DELETE. The router also rejects POST and DELETE whose `Origin` differs. Requests with no `Origin` header pass the Origin check and rely on SameSite. |
| T9 | 1 | Information disclosure | Project metadata | Malicious website | Cross-site WebSocket hijacking of `/live`. | Medium | `/live` checks `Origin` equals the Worker origin. |
| T10 | 1 | Information disclosure | Project metadata | Malicious website | Clickjacking, or framing the dashboard. | Low | CSP `frame-ancestors 'none'`. |
| T11 | 4 | Elevation of privilege | Device management, passkeys | Holder of a stolen widget cookie | Widget session reaches browser-only routes or adds a passkey. | High | Gate allows widget sessions only on `WIDGET_PATHS`. Passkey registration with a session requires `kind === "browser"` plus a fresh user-verified assertion. Test: path tricks (trailing slash, encoding, case, `HEAD`). |
| T12 | 4 | Elevation of privilege | Passkeys | Holder of a stolen browser cookie | Adds their own passkey so access outlives the stolen cookie. | Medium | Fixed: registering a passkey, minting a machine token (`POST /api/machines`), pairing a widget (`POST /api/pairing`), approving a device code and removing a passkey (`DELETE /api/devices/passkey/:id`) each need a fresh user-verified assertion from any registered passkey, using a single-use login challenge; revoking a machine, widget or browser still needs no assertion. The credential created descends from the passkey that signed the assertion and is written only while that passkey still exists. A stolen browser cookie alone can no longer mint tokens, pair a widget, approve a device, or remove a passkey; it can still read data until the session is revoked or expires (T30). |
| T13 | 4 | Repudiation | Device management | Holder of a stolen browser cookie | Owner cannot tell which session created a token or revoked a device. | Low | Accepted: single-owner app with no audit log. `/devices` lists every session, token and passkey, but shows last-used time only for machine tokens. Owner, until 2027-04-19. |
| T14 | 1 | Elevation of privilege | All | Internet stranger | `DEV_SKIP_AUTH=1` reaches a deployed Worker and disables auth. | High | Bypass applies only when the request hostname is `localhost` or `127.0.0.1`, which a deployed Worker never sees. The flag is never in `.dev.vars.example`. Test: Host header spoofing against the deployed URL. |
| T15 | 6 | Information disclosure | Machine tokens | Process on a monitored machine | Reads the token from `~/.config/cession/token` or the environment. | Low | Accepted: same-user code already reads all Claude Code data on that machine. Token is write-only to cession and revocable. Token never appears in argv (`curl -K -`), the chat, or stdout. Check: token file mode is 0600. Owner, until 2027-04-19. |
| T16 | 6 | Tampering | Owner's machine | Writer of ingested strings | A hostile directory name or `CESSION_URL` injects options into curl or the shell. | Medium | `report.sh` rejects tokens outside the base64url alphabet, rejects URLs with userinfo, and accepts only https or localhost http. Values go through `jq --arg`, never through the shell. |
| T17 | 1 | Information disclosure | Machine tokens | Network observer | Token sent over plain http. | Medium | `report.sh` refuses http except for localhost. HSTS on https. Test: the OTel exporter endpoint configured by `/cession:setup` also uses https. |
| T18 | 7 | Spoofing | Session cookies | Network attacker, malicious app | Unsigned widget `.dmg` is swapped or tampered with before install. | Medium | Accepted for now: release builds are unsigned and not notarised, and no checksum or provenance attestation is published yet (see T33). Owner, until 2027-04-19. |
| T19 | 1 | Information disclosure | All | Internet stranger | Error responses reveal stack traces or internals. | Low | Thrown errors become a bare 500 with security headers; details go to `console.error` only. |
| T20 | 3 | Spoofing | Passkeys | Internet stranger | WebAuthn replay, wrong origin or RP ID, missing user verification. | High | `@simplewebauthn/server` with expected origin and RP ID set to the request URL, `requireUserVerification`, single-use challenges with a 5-minute TTL, signature counter tracked. |
| T22 | 6 | Elevation of privilege | Owner's machine | Anyone who gets the owner to run `/cession:setup` against their URL | `login.sh` put server-supplied `expires_in` into `$(( ))`; `/bin/sh` evaluates `a[$(cmd)]` there, which ran commands on the owner's machine. It also opened any server-supplied link. | High | Fixed: `interval` and `expires_in` must be digits, and only `<url>/device?code=` links are opened. |
| T23 | 2, 4 | Denial of service | Availability | Internet stranger | `POST /events` with any bearer value, or any request with a junk `__Host-cession` cookie, reaches the single Hub with no rate limit. A flood stalls ingest, the dashboard and WebSockets. | Medium | Fixed: `TOKEN_RE` and `SESSION_RE` reject a bearer or `__Host-cession` cookie of the wrong shape before any Hub call, and `GATE_LIMITER` (1200/min per client) caps every non-`/auth/` route, ingest included, the way `AUTH_LIMITER` already caps `/auth/*`. |
| T24 | 4 | Elevation of privilege | Session cookies, machine tokens | Holder of an old widget cookie or machine token | Widget sessions, machine tokens and pairing codes created before passkey linking have `passkey_id` NULL, so removing a passkey never revokes them. | Low | Open. Fix: the migration deletes NULL-linked widget sessions and pairing codes, and `/devices` flags NULL-linked machine tokens. |
| T25 | 6 | Information disclosure | Machine tokens | Anyone with the owner's dotfiles | `/devices` suggests `export CESSION_TOKEN=` in `~/.zshrc` (often 644 and synced to dotfile repos). `setup.sh` leaves `settings.json.bak` with default permissions; it may hold an old token. | Low | Open: `/devices` still suggests `export CESSION_TOKEN=` in `~/.zshrc`. Fixed: `setup.sh` recreates `settings.json.bak` (`rm -f` then `cp` under `umask 077`) instead of copying onto an existing file, so the backup is always mode 0600 even if a 644 one already existed. |
| T26 | 3 | Denial of service | Availability | Malicious website | While the owner has the page open, 10 cross-site `POST /auth/pair` requests lock pairing for the owner's IP for 10 minutes (`/auth/pair` is exempt from the Origin check). Repeated `<img src=/auth/x>` GETs use up the owner's `AUTH_LIMITER` budget, so passkey login returns 429. | Low | Fixed: `/auth/pair` accepts only an absent `Origin`, the Worker's own origin, or exactly `tauri://localhost`, rejecting `Origin: null` and any other value with 403. `AUTH_LIMITER` now counts only `POST /auth/*`; `GATE_LIMITER` covers every other request, including a non-POST `/auth/*` GET, so neither path can exhaust the owner's login budget. |
| T27 | 2 | Tampering | Usage and cost | Holder of a leaked machine token | Two OTLP points of `1e308` sum to Infinity; SQLite stores it, JSON serialises it as null, and that day's cost shows $0 until the row ages out after 365 days. | Low | Fixed: `otlp.ts` drops a single point over `MAX_USAGE` (1e12), filters per-session/column totals over `MAX_USAGE` after summing, and `Hub.applyUsage` skips writing a computed total that is non-finite or exceeds `MAX_USAGE`. |
| T28 | 6 | Tampering | Owner's machine | Anyone who gets the owner to run `/cession:setup` against their URL | `login.sh` prints the server's `user_code` and the tail of `verification_uri_complete` raw (the prefix check still lets text after `code=` through). Newlines, instructions or terminal escape sequences in it reach the terminal and Claude's context, which makes it a prompt-injection path. | Low | Fixed: `login.sh` accepts only a `user_code` matching `[A-Z0-9-]{1,16}`, builds the approval link itself from `$url/device?code=$code` instead of reading `verification_uri_complete`, and prints the server-supplied name, link and code with `printf '%s\n'`. |
| T29 | 6 | Information disclosure | Machine tokens, project metadata | Anyone who gets the owner to run `/cession:setup` against their URL | With a token already saved, `setup.sh` sends it to the new URL's `/events` (accepting any 400) and points `CESSION_URL` and OTel there. The attacker gets a valid token and a continuous feed of cwd, branch and cost. | Medium | Fixed: `login.sh` saves the server's origin next to the token; `report.sh`, the OTel headers helper and `setup.sh` send the file token only to that saved origin, and `setup.sh` runs device login instead when the URL's origin differs. The same binding mitigates the project-settings variant, since a repository's `.claude/settings.json` pointing `CESSION_URL` or the OTel endpoints elsewhere no longer carries the token with it. Open: a legacy install with a token file but no origin file yet still has `report.sh` sending to whatever `CESSION_URL` is configured, so the project-settings variant still applies there until `/cession:setup` is rerun; rerunning it to upgrade leaves the old token valid until it's revoked on the Devices page. |
| T30 | 4 | Elevation of privilege | Session cookies | Holder of a stolen widget or browser cookie | `getSession` slides expiry on use with no absolute cap, so a cookie used at least every 29 days never expires, and `/devices` shows no last-used time for sessions. | Low | Open. Fix: absolute lifetime from `created_at`, and show `last_used` for widgets and browsers. |
| T31 | 3 | Denial of service | Availability | Stranger sharing the owner's IPv4 or /64 (CGNAT, VPN, office) | 30 `/auth/login/options` calls, 10 `/auth/device` calls or 10 bad setup codes per 10 minutes lock the owner out of login, device login and `SETUP_CODE` recovery from that network. Step-up for a sensitive action (minting a token, pairing, approving a device, removing a passkey) fetches its challenge from the same endpoint, so the same `login_opts` budget blocks those too. | Low | Open. Fix: clear a prefix's `login_opts` failures after a successful login, or bound challenge rows globally instead of per client. Otherwise accept. |
| T32 | 2 | Tampering | Usage and cost | Holder of a leaked machine token who knows a session id | An event with an old `ts` permanently moves `started_at` back (`MIN`), moving the session to another day in history and inflating its duration. | Low | Fixed: `parseEvent` also rejects a hook event `ts` more than 24 hours old, alongside the existing future-skew check, replacing the old fixed 2020 floor. |
| T33 | CI | Tampering | Owner's machine, widget build | Malicious dependency or build tool | `widget-release.yml` gives the whole job `contents: write` while running build code, checkout keeps the token in `.git/config`, the Rust cache can be seeded from main, `tauri-cli` floats within 2.x (its install is `--locked`, but `cargo tauri build` is not). Build code could replace release assets or push to unprotected branches. | Low | Open. Fix: `persist-credentials: false`, build with `contents: read` and publish from a separate job, drop rust-cache in the release job, pin `tauri-cli`, build `--locked`, publish SHA-256 or build provenance. |
| T34 | CI | Information disclosure | Sonar credentials | Malicious npm dependency | `SONAR_TOKEN` is set in the job-level `env` of `quality_gate.yml`, so `npm ci` lifecycle scripts and tests can read it. | Low | Fixed: `SONAR_TOKEN` and `SONAR_HOST_URL` are set only on the Sonar scan, quality-gate check and summary steps in `quality_gate.yml`, not job-wide, so `npm ci` lifecycle scripts and tests never see them. |
| T35 | 4 | Elevation of privilege | Machine tokens, session cookies | Holder of a stolen browser cookie | A pairing, token or device approval in flight while the owner removes the passkey is inserted with a dangling `passkey_id` and escapes the cascade. | Low | Fixed: `createMachineToken`, `createPairingCode`, `createSession` and `approveDeviceCode` in `authstore.ts` insert or update only `WHERE EXISTS` the passkey, in the same SQL statement as the write, so a pairing, token, approval or session in flight when the owner removes the passkey can no longer carry a dangling `passkey_id`. |
| T36 | Repo | Information disclosure | `SETUP_CODE` | Anyone reading the public repo | `.gitignore` ignores `.dev.vars` but not `.dev.vars.<env>` or `.env`, both of which wrangler reads, so a `git add .` could publish the setup code. | Low | Fixed: `.gitignore` ignores `.dev.vars*` and `.env*`, keeping `.dev.vars.example` tracked, and ignores `.claude/settings.local.json`. |
| T37 | CI | Elevation of privilege | All | Publisher of a new advisory | Trivy runs only when a lockfile changes, so a new advisory for a locked package is never flagged; `tauri-nspanel` is a git dependency no advisory database matches. | Low | Fixed: `trivy.yml` also runs on a weekly schedule and on manual dispatch, so a new advisory for an already-locked package is caught without waiting for a lockfile change. Open: `tauri-nspanel` stays a git dependency pinned to a commit on branch v2.1 in `Cargo.lock`, which no advisory database matches. Open: Dependabot alerts are a repo setting the owner still needs to turn on. |
| T38 | 2 | Denial of service | Availability | Holder of a leaked machine token | `attr()` in `otlp.ts` returns `stringValue` unchecked, so an array bypasses the 256-character `session.id` cap; workerd stores it stringified (3M characters tested), and every snapshot then carries it to every socket. | Low | Fixed: `attr()` returns `stringValue` only when it is a string, so a non-string value is treated as absent and the point is dropped when it carries `session.id`. |
| T39 | 7 | Spoofing | Owner's credentials | Script running on the paired origin (needs T7 or a hostile paired server) | Navigating the widget to `tauri://localhost/index.html#pair` clears the origin pin at decision time; a second navigation then pins an attacker origin in the always-on-top panel, where a fake sign-in or `SETUP_CODE` form can be shown. Tauri also allows any URL that `url` cannot parse. | Low | Fixed: the pin is a three-state `Pin::{Unpaired, Paired, Resetting}`. Only the tray's "Pair with server…" handler moves it to `Resetting`, which allows just `tauri://localhost` and pins nothing; `Resetting` moves to `Unpaired` only once `on_page_load` reports `PageLoadEvent::Finished` on `tauri://localhost`, so an in-flight navigation from the still-loading (possibly attacker-controlled) page can no longer land during the reset window. Open: Tauri still allows any URL that `url` cannot parse; `allow()` has no path to deny one. |
| T40 | 6 | Information disclosure | Machine tokens | Operator of another OTel collector the owner uses | `setup.sh` installs a global `otelHeadersHelper`, so the cession token may go to logs and traces exporters pointed elsewhere; the consent prompt says other OTel keys are replaced when the merge keeps them, and a corporate `OTEL_EXPORTER_OTLP_HEADERS` can reach cession. | Low | Fixed: `setup.sh` tags every `OTEL_*` key as blocked, replaced or kept; a blocked key (a non-metrics OTLP endpoint, generic endpoint or headers, or a logs/traces exporter set to `otlp`) exits 3 even with `--yes`, and the `--yes` prompt lists replaced and kept keys separately so it matches what the merge does. |
| T41 | 6 | Tampering | Owner's files | Another local account on the Mac | `make widget` writes to the fixed path `/tmp/cession-widget.log`; a pre-planted symlink truncates and overwrites an owner file, and a pre-created world-readable file leaks logs. | Low | Fixed: `make widget` writes its log under `${TMPDIR:-/tmp}/cession-widget.log` instead of a fixed `/tmp` path. |
| T42 | Supply chain | Elevation of privilege | All | Anyone who gets code merged upstream | The README tells button-deployed owners to sync from upstream `main`, and Workers Builds redeploys whatever is there. | Low | Accepted as a property of self-hosting from a public repo, pending owner sign-off. Fix to consider: point owners at reviewed, tagged releases. |
| T43 | 2, 4 | Denial of service | Availability | Malicious website open in the owner's browser, a stranger sharing the owner's /64 or IPv4, or the owner's own heavy parallel agent use | `GATE_LIMITER` (1200/min per client /64 or IPv4) is shared by ingest, the dashboard and `/live`, so cross-site GETs, another client on the same network, or enough concurrent agents can spend it and stall hook ingest for up to a minute. | Low | Accepted, pending owner sign-off. The limit can be tuned in `server/wrangler.jsonc`. |
| T21 | 1 | Information disclosure | Project metadata | Cloudflare account compromise | Anyone with the owner's Cloudflare account reads the Durable Object or deploys modified code. | Medium | Out of scope for the test. Owner action: hardware-key 2FA on the Cloudflare and GitHub accounts, and a scoped API token for deploys. |

## Pen test brief

For the testing firm.

**Target.** A dedicated deployment, not the owner's production Worker: `cession-pentest.<account>.workers.dev`, deployed from the tagged commit under test with its own `SETUP_CODE`. Destroy it after the test.

**Accounts and credentials provided.**

- One registered passkey for the test deployment (testers register their own software or hardware authenticator using a test `SETUP_CODE`, then the code is rotated).
- One machine token, created in `/devices`.
- One widget pairing code on request.

**Allowed.** Everything against the test deployment, including authenticated and unauthenticated testing, brute forcing within the rate limits, and running the plugin and widget on tester machines.

**Not allowed.** Testing the owner's production Worker, other `*.workers.dev` hosts, Cloudflare infrastructure, or volumetric DoS. Application-level resource exhaustion (T4, T6) is allowed against the test deployment at modest rates; agree a window first.

**Priority areas.** Whether `CF-Connecting-IP` can be forged when the Worker is called from another Worker, which would bypass every per-client limit. T7 (stored XSS through ingested strings), T11 (widget scope escape), T1 and T2 (code guessing and lockout bypass with IPv6 prefix rotation), T14 (dev bypass), T5 and T6 (ingest abuse with a valid token), T3 (device-login phishing flow).

**Source access.** White-box. The repository is public; `AGENTS.md` lists the intended invariants.

**Deliverable.** Findings with reproduction steps, mapped to the threat IDs above where possible.

## Owner actions before the test

- [ ] Confirm the accepted risks T13, T15, T18, T42 and T43 by name and date.
- [ ] Fix or accept T3, T5, T6, T24, T25, T29, T30, T31, T33, T37, T39.
- [x] Add tests: `/live` closes on passkey removal and on logout (code 4001); OTLP drops a non-string `stringValue`.
- [ ] Deploy the dedicated test Worker and give testers the URL and a temporary `SETUP_CODE`.
- [ ] Turn on hardware-key 2FA for the Cloudflare and GitHub accounts (T21).
- [ ] Add a `SECURITY.md` with a private reporting channel (GitHub private vulnerability reporting).
- [ ] Enable Dependabot or `npm audit` in CI for `server/` and `cargo audit` for `widget/`.
