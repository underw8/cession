import { allowedPairOrigin, clearCookie, clientKey, clientKeys, ingestAuthorized, isLocalhost, isWidget, readSession, sameOrigin, sessionCookie, status } from "./auth";
import { DEVICE_TTL_MS, sha256hex, type DeviceKind, type Session } from "./authstore";
import { parseEvent } from "./event";
import { parseOtlp } from "./otlp";
import { freshPasskey, passkeyRoute } from "./passkey";

import type { Hub } from "./hub";

export { Hub } from "./hub";

// Everything a widget session may reach; the rest (devices, pairing, tokens) is browser-only.
// A new asset the widget loads must be added here, or the widget gets 403.
const WIDGET_PATHS = new Set(["/", "/live", "/api/sessions", "/api/history", "/api/me"]);
const DEVICE_PATH = /^\/api\/devices\/(machine|widget|browser|passkey)\/([^/]+)$/;

// 'unsafe-inline' because every page is a single file with inline <script>/<style>.
// ws(s)://host is explicit because older WKWebView (the widget) doesn't match it against 'self'.
function csp(url: URL): string {
  const ws = url.protocol === "http:" ? ` wss://${url.host} ws://${url.host}` : ` wss://${url.host}`;
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${ws}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

function withSecurityHeaders(req: Request, res: Response): Response {
  if (res.status === 101) return res; // WebSocket upgrade; headers are immutable
  const out = new Response(res.body, res); // ASSETS and Response.redirect headers are immutable
  out.headers.set("Content-Security-Policy", csp(new URL(req.url)));
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "same-origin");
  if (new URL(req.url).protocol === "https:") out.headers.set("Strict-Transport-Security", "max-age=31536000");
  return out;
}

export default {
  async fetch(req, env): Promise<Response> {
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      console.error(e);
      res = status(500);
    }
    return withSecurityHeaders(req, res);
  },
} satisfies ExportedHandler<Env>;

type Ctx = { req: Request; env: Env; url: URL; hub: DurableObjectStub<Hub> };
type SessionCtx = Ctx & { session: Session };
type Handler<C> = (c: C) => Promise<Response> | Response;

const notFound = () => status(404, "unknown or expired code");
const dashed = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
// Malformed JSON reads as an empty object, so handlers only check field types.
const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  const body = await req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
};
const field = (body: Record<string, unknown>, key: string, max: number) => {
  const v = body[key];
  return typeof v === "string" && v.length <= max ? v : "";
};
const machineName = (body: Record<string, unknown>) => {
  const v = body.name;
  const name = typeof v === "string" ? v.trim() : "";
  return name.length >= 1 && name.length <= 64 ? name : null;
};

// Machines post with a bearer token and never see a cookie, so these run before the CSRF check and the gate.
const INGEST: Record<string, Handler<Ctx>> = {
  "POST /events": async ({ req, hub }) => {
    if (!(await ingestAuthorized(req, hub))) return status(401, "unauthorized");
    const event = parseEvent(await req.json().catch(() => null));
    if (!event) return status(400, "bad event");
    await hub.applyEvent(event);
    return status(204);
  },
  "POST /v1/metrics": async ({ req, hub }) => {
    if (!(await ingestAuthorized(req, hub))) return status(401, "unauthorized");
    const text = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return status(400, "bad json");
    }
    // An exporter retry resends the identical body; its digest lets the Hub count it once.
    await hub.applyUsage(parseOtlp(body), await sha256hex(text));
    return Response.json({});
  },
};

async function redeemPairing({ req, url, hub }: Ctx): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const value = form?.get("code");
  const code = typeof value === "string" ? value : "";
  // Real codes are 9 characters; anything long is junk that shouldn't be hashed in the Hub.
  const res = code.length > 64 ? { status: "bad" as const } : await hub.redeemPairingCode(code, "Widget", ...clientKeys(req));
  if (res.status === "locked") return status(429, "too many attempts");
  if (!("raw" in res)) return new Response(null, { status: 303, headers: { Location: new URL("/pair?error=1", url).toString() } });
  return new Response(null, { status: 303, headers: { Location: new URL("/", url).toString(), "Set-Cookie": sessionCookie(res.raw) } });
}

// Device login (RFC 8628): a machine starts it and polls; a signed-in browser approves it at /device.
async function startDeviceLogin({ req, url, hub }: Ctx): Promise<Response> {
  const name = machineName(await readJson(req));
  if (!name) return status(400, "name must be 1-64 characters");
  // Unauthenticated and each call stores a row, so budget them per client prefix; never cleared.
  const keys = clientKeys(req);
  if ((await hub.claimAttempt(...keys.map((k) => `device:${k}` as const))) === null) return status(429, "too many attempts");
  // The raw address, shown on the approval page so the owner can spot a request that isn't theirs.
  const ip = (req.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 64);
  const { device_code, user_code } = await hub.createDeviceCode(name, ip);
  const code = dashed(user_code);
  const verification_uri = new URL("/device", url).toString();
  return Response.json({
    device_code, user_code: code, verification_uri,
    verification_uri_complete: `${verification_uri}?code=${code}`,
    expires_in: DEVICE_TTL_MS / 1000, interval: 3,
  });
}

async function pollDeviceLogin({ req, hub }: Ctx): Promise<Response> {
  const deviceCode = field(await readJson(req), "device_code", 64);
  const res = deviceCode ? await hub.pollDeviceCode(deviceCode) : "expired";
  if (typeof res === "object") return Response.json(res);
  return Response.json({ error: res === "pending" ? "authorization_pending" : "expired_token" }, { status: 400 });
}

// Reachable without a session, after the CSRF check.
const PUBLIC: Record<string, Handler<Ctx>> = {
  "GET /login": ({ req, env }) => env.ASSETS.fetch(req),
  "GET /pair": ({ req, env }) => env.ASSETS.fetch(req),
  "POST /auth/pair": redeemPairing,
  "POST /auth/device": startDeviceLogin,
  "POST /auth/device/token": pollDeviceLogin,
};

function signedOut({ req, url }: Ctx): Response {
  if (url.pathname.startsWith("/api/") || url.pathname === "/live") return status(401, "unauthorized");
  if (isWidget(req)) return Response.redirect(new URL("/pair", url).toString(), 302);
  // Back to the page asked for after sign-in (login.html only follows same-origin paths).
  const login = new URL("/login", url);
  if (url.pathname !== "/") login.searchParams.set("next", url.pathname + url.search);
  return Response.redirect(login.toString(), 302);
}

function live({ req, hub, session }: SessionCtx): Promise<Response> | Response {
  if (req.headers.get("Upgrade") !== "websocket") return status(426, "expected websocket");
  if (!sameOrigin(req)) return status(403, "forbidden origin");
  const headers = new Headers(req.headers);
  headers.set("X-Cession-Session", session.id);
  return hub.fetch(new Request(req, { headers }));
}

async function history({ url, hub }: SessionCtx): Promise<Response> {
  const by = url.searchParams.get("by") ?? "day";
  const to = Number(url.searchParams.get("to") ?? Date.now());
  const from = Number(url.searchParams.get("from") ?? to - 7 * 86_400_000);
  if ((by !== "day" && by !== "project") || !Number.isFinite(from) || !Number.isFinite(to)) return status(400, "bad query");
  return Response.json(await hub.history(from, to, by));
}

// passkeyId is the passkey that signed the step-up, so removing it revokes what was created.
type BodyCtx = SessionCtx & { body: Record<string, unknown>; passkeyId: string | null };

// A fresh assertion in the body is required so a stolen cookie alone can't mint or remove a passkey; resolves to the signing passkey (null for the dev session) or the refusal.
async function stepUp({ hub, url, session }: SessionCtx, body: Record<string, unknown>): Promise<string | null | Response> {
  if (session.id === "dev") return null;
  return (await freshPasskey(hub, body, url)) ?? status(401, "reauthenticate");
}

const fresh = (handler: Handler<BodyCtx>): Handler<SessionCtx> => async (c) => {
  const body = await readJson(c.req);
  const signed = await stepUp(c, body);
  return signed instanceof Response ? signed : handler({ ...c, body, passkeyId: signed });
};

async function revokeDevice(c: SessionCtx): Promise<Response> {
  const { req, env, url, hub, session } = c;
  const device = DEVICE_PATH.exec(url.pathname);
  if (!device) return env.ASSETS.fetch(req);
  const [, kind, id] = device;
  const signed = kind === "passkey" ? await stepUp(c, await readJson(req)) : null;
  if (signed instanceof Response) return signed;
  if (!(await hub.revoke(kind as DeviceKind, id))) return status(404, "not found");
  const self = kind === session.kind && id === session.id;
  return new Response(null, { status: 204, headers: self ? { "Set-Cookie": clearCookie() } : {} });
}

// Behind the session gate; anything not listed (or a DELETE handled by revokeDevice) is a static asset.
const SESSION_ROUTES: Record<string, Handler<SessionCtx>> = {
  "GET /api/me": ({ session }) => Response.json({ kind: session.kind }),
  "GET /api/sessions": async ({ hub }) => Response.json(await hub.snapshot()),
  "GET /api/history": history,
  "GET /api/devices": async ({ hub, session }) => Response.json(await hub.devices(session.id)),
  "POST /api/machines": fresh(async ({ body, url, hub, passkeyId }) => {
    const name = machineName(body);
    if (!name) return status(400, "name must be 1-64 characters");
    const created = await hub.createMachineToken(name, passkeyId);
    return created ? Response.json({ ...created, url: url.origin }) : status(401, "unauthorized");
  }),
  "GET /api/device": async ({ url, hub }) => {
    const code = url.searchParams.get("code") ?? "";
    const request = code.length <= 64 ? await hub.lookupDeviceCode(code) : null;
    return request ? Response.json(request) : notFound();
  },
  "POST /api/device/approve": fresh(async ({ body, hub, passkeyId }) => {
    const code = field(body, "code", 64);
    return code && (await hub.approveDeviceCode(code, passkeyId)) ? status(204) : notFound();
  }),
  "POST /api/pairing": fresh(async ({ hub, passkeyId }) => {
    const created = await hub.createPairingCode(passkeyId);
    return created ? Response.json({ code: dashed(created.code), expires_at: created.expires_at }) : status(401, "unauthorized");
  }),
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const c: Ctx = { req, env, url, hub: env.HUB.get(env.HUB.idFromName("hub")) };
  // Keys contain a space, so no lookup can hit an Object.prototype member.
  const key = `${req.method} ${url.pathname}`;

  // Every /auth/* route is POST-only, so a POST there spends the tighter AUTH_LIMITER budget below
  // and everything else - every other route, and any non-POST /auth/* request, ingest included -
  // spends this shared one; both run before any Hub call. Local dev and tests have no real client
  // address, so only deployed hosts are limited.
  const authPost = req.method === "POST" && url.pathname.startsWith("/auth/");
  if (!authPost && !isLocalhost(req)) {
    const { success } = await env.GATE_LIMITER.limit({ key: clientKey(req) });
    if (!success) return status(429, "too many requests");
  }

  const ingest = INGEST[key];
  if (ingest) return ingest(c);

  // CSRF check; /auth/pair is exempt because its pairing code is the credential, but it still
  // rejects any Origin other than the Worker's own or the widget's fixed "tauri:" one.
  if ((req.method === "POST" || req.method === "DELETE") && !sameOrigin(req) && url.pathname !== "/auth/pair")
    return status(403, "forbidden origin");
  if (url.pathname === "/auth/pair" && !allowedPairOrigin(req)) return status(403, "forbidden origin");

  if (authPost && !isLocalhost(req)) {
    const { success } = await env.AUTH_LIMITER.limit({ key: clientKey(req) });
    if (!success) return status(429, "too many requests");
  }

  const open = PUBLIC[key];
  if (open) return open(c);
  const authRes = await passkeyRoute(req, env, c.hub);
  if (authRes) return authRes;

  const session = await readSession(req, env, c.hub);
  if (!session) return signedOut(c);
  if (session.kind === "widget" && !WIDGET_PATHS.has(url.pathname)) return status(403, "forbidden");

  const s: SessionCtx = { ...c, session };
  if (url.pathname === "/live") return live(s);
  const handler = SESSION_ROUTES[key] ?? (req.method === "DELETE" ? revokeDevice : undefined);
  return handler ? handler(s) : env.ASSETS.fetch(req);
}
