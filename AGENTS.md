# cession — Agent Guide

Live view and cost history of every Claude Code session across one person's machines: a Claude Code plugin reports hook events and OTel metrics to a Cloudflare Worker, which serves a dashboard and an always-on-top macOS widget.

## Build & Test

`make help` lists shortcuts (`make test`, `make deploy`, `make widget`, …).

```bash
cd server
npm install
npm test               # vitest in workerd via @cloudflare/vitest-plugin
npm run typecheck      # regenerates worker-configuration.d.ts (gitignored), then tsc for src and test
npm run dev            # wrangler dev on http://localhost:8787, auth bypassed for localhost
npm run deploy

sh plugin/test.sh      # end-to-end hook test against a running `npm run dev`; prints PASS

cd widget && cargo build && cargo test
```

**Before calling server work done, run `npm test` and `npm run typecheck` in `server/`. For widget work, run `cargo build` and `cargo test` in `widget/`.** No linter or formatter is configured.

## Layout

```
server/src/index.ts       router: ingest routes, CSRF check, auth routes, session gate, API/WS/assets
server/src/hub.ts         Durable Object "Hub": all state in SQLite, status machine, WS broadcast, alarm, history
server/src/authstore.ts   sessions, passkeys, machine tokens, pairing codes, lockout (SQL used by Hub)
server/src/passkey.ts     WebAuthn routes
server/src/auth.ts        machine token and cookie checks, lockout client keys
server/src/event.ts       hook event validation;  otlp.ts: OTLP metrics → usage updates
server/public/            one inline-script HTML file per page, no build step
server/test/              vitest suites; helpers.ts, authenticator.ts (software WebAuthn authenticator)
plugin/                   Claude Code plugin: hooks/report.sh, skills/setup (/cession:setup)
widget/                   Tauri v2 NSPanel showing the dashboard; ui/index.html is the local pairing page
```

## Architecture

| Route | Auth | Behaviour |
|---|---|---|
| `POST /events`, `POST /v1/metrics` | `Bearer` machine token | hook event / OTLP JSON into the Hub |
| `POST /auth/register/*`, `/auth/login/*`, `/auth/logout` | `SETUP_CODE`, or a browser session plus a fresh assertion | passkey ceremony, issues the session cookie |
| `POST /auth/pair` | one-time pairing code | widget gets a session cookie |
| `POST /auth/device`, `/auth/device/token` | none; budgeted per client | device login (RFC 8628): a machine starts it, then polls until a browser approves |
| `/device`, `/api/device`, `/api/device/approve` | browser session only | look up and approve a device login code |
| `/live` | session cookie | WebSocket (hibernation); full snapshot on every change |
| `/api/sessions`, `/api/history`, `/api/me` | session cookie | reads, reachable by widget and browser |
| `/api/devices`, `/api/machines`, `/api/pairing`, `/api/devices/:kind/:id` | browser session only | manage tokens, widgets, browsers, passkeys |
| anything else | session cookie | static dashboard |

- One Durable Object, fixed name `"hub"`. Status per hook event is `STATUS_FOR_EVENT` in `hub.ts`; the alarm marks silent sessions `stale` and prunes old rows.
- `last_seen` is server arrival time (hooks and metric exports both move it) and drives the stale sweep. `last_event` is the machine's own `ts` and orders events: status changes only when `ts >= last_event`, so `parseEvent` rejects a ts too far ahead rather than clamping it.
- History counts sessions by start time but cost and tokens by the UTC day they accrued (`usage_daily`).
- Everything a passkey signs in or creates (browser sessions, machine tokens, pairing codes, widget sessions) carries its `passkey_id`; removing the passkey removes them.
- The widget's User-Agent includes `cession-widget`. The server uses it only to pick `/pair` over `/login` for redirects; scope is enforced by the session's `kind` against `WIDGET_PATHS`.

## Invariants

- **Ingest routes stay above the session gate** in `index.ts`; machines never see a cookie. `test/gate.test.ts` guards this.
- **`DEV_SKIP_AUTH=1` bypasses the gate only for hostname `localhost`/`127.0.0.1`.** It is passed on the `npm run dev` command line, never in `.dev.vars` or `.dev.vars.example` (the deploy button would prompt it in). Don't add `--local-upstream` to `npm run dev`: it rewrites every Host to localhost, so DNS rebinding would get through. For real passkey login locally, set `SETUP_CODE` in `server/.dev.vars` and run `npx wrangler dev --local-upstream localhost:8787` without the `--var`.
- **Lockout** check and failure record happen in one synchronous Hub step (`claimAttempt`, `trySetupCode`, `redeemPairingCode`), so parallel guesses can't race past it. There are no global ceilings, so a stranger can only lock their own prefix; that relies on the 32-character `SETUP_CODE` minimum. Login verify has no failure lock on purpose.
- **Usage column names are interpolated into SQL;** only use names from `USAGE_COLUMNS`.
- **Security headers** are added to every response except 101, including thrown-error 500s. A page that loads anything cross-origin needs the CSP widened.
- **report.sh** always exits 0 silently, never blocks (git and curl run in a background subshell), and keeps the token out of argv (`curl -K -`).
- **Session cookie** `__Host-cession` is `Secure`, so widget pairing against plain `http://localhost` won't keep it.
- `// ponytail:` comments mark deliberate simplifications. Keep them when editing nearby code.

## Widget (macOS)

- The `NSEvent` monitor in `handle_mouse` owns drag and resize; the panel's native resizable mask is off on purpose. The panel doesn't activate the app, so `data-tauri-drag-region` doesn't work.
- `src/chrome.js` only draws the hover chrome; `hit()` in `main.rs` does the hit-testing, so their sizes must agree.
- `tauri_panel!` already imports `NSEvent`, `NSWindow`, `NSPoint`/`NSRect`/`NSSize`, `MainThreadMarker`, `msg_send` and `AnyObject`; importing them again fails with E0252.
- `widget/icons/icon.png` must exist, or `tauri::generate_context!` fails to compile.

## Testing

Tests run inside workerd with real Durable Object storage; nothing is mocked. `vitest.config.ts` binds `DEV_SKIP_AUTH=1`; `authEnv` in `helpers.ts` unsets the bypass, and `post()` ingests with a shared machine token from `machineToken()`. Storage is shared across tests and never reset, so isolate with `uid()`.

```bash
npx vitest run test/events.test.ts
npx vitest run -t "older event arriving late"
```

## Style

TypeScript `strict`, 2-space indent, double quotes, semicolons. snake_case for DB and API fields, camelCase in TS, SCREAMING_CASE for constants. Comments are short and state why. Conventional Commits with scopes `server`, `plugin`, `dashboard`, `widget`.

## Configuration

- `SETUP_CODE` (`npx wrangler secret put SETUP_CODE`, at least 32 characters, e.g. `openssl rand -hex 16`) registers the first passkey and recovers a lost one. `.dev.vars.example` leaves it blank on purpose.
- Per machine: the token comes from `CESSION_TOKEN`, or else from `~/.config/cession/token` (`$XDG_CONFIG_HOME` aware), which `/cession:setup` fills through a device login (`plugin/skills/setup/login.sh`). The token never passes through the chat, argv or stdout; `/cession:setup` writes `CESSION_URL` and the OTel vars to `~/.claude/settings.json`; `CESSION_MACHINE` overrides `hostname -s`.

## Pitfalls

- Deploy target is `workers_dev`; `preview_urls` stays off. A custom domain is an optional `routes` entry.
- Never bind `npm run dev` to `0.0.0.0`.
- `assets.run_worker_first: true` keeps the dashboard HTML behind the session gate.
- No hook fires when a permission is approved; PostToolUse moves needs_you back to working.
- Don't add `idle_prompt` to the Notification matcher; it would flag idle sessions as needs_you.
