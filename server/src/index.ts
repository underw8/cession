import { clearCookie, clientKeys, ingestAuthorized, isWidget, readSession, sameOrigin, sessionCookie, status } from "./auth";
import { DEVICE_TTL_MS, type DeviceKind } from "./authstore";
import { parseEvent } from "./event";
import { parseOtlp } from "./otlp";
import { passkeyRoute } from "./passkey";

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

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const hub = env.HUB.get(env.HUB.idFromName("hub"));

  if (req.method === "POST" && url.pathname === "/events") {
    if (!(await ingestAuthorized(req, hub))) return status(401, "unauthorized");
    const event = parseEvent(await req.json().catch(() => null));
    if (!event) return status(400, "bad event");
    await hub.applyEvent(event);
    return status(204);
  }

  if (req.method === "POST" && url.pathname === "/v1/metrics") {
    if (!(await ingestAuthorized(req, hub))) return status(401, "unauthorized");
    const body = await req.json().catch(() => undefined);
    if (body === undefined) return status(400, "bad json");
    await hub.applyUsage(parseOtlp(body));
    return Response.json({});
  }

  // CSRF check; /auth/pair is exempt because its pairing code is the credential.
  if ((req.method === "POST" || req.method === "DELETE") && !sameOrigin(req) && url.pathname !== "/auth/pair")
    return status(403, "forbidden origin");

  if (req.method === "GET" && (url.pathname === "/login" || url.pathname === "/pair")) return env.ASSETS.fetch(req);
  if (req.method === "POST" && url.pathname === "/auth/pair") {
    const form = await req.formData().catch(() => null);
    const code = String(form?.get("code") ?? "");
    // Real codes are 9 characters; anything long is junk that shouldn't be hashed in the Hub.
    const res = code.length > 64 ? { status: "bad" as const } : await hub.redeemPairingCode(code, "Widget", ...clientKeys(req));
    if (res.status === "locked") return status(429, "too many attempts");
    if (!("raw" in res)) return new Response(null, { status: 303, headers: { Location: new URL("/pair?error=1", url).toString() } });
    return new Response(null, { status: 303, headers: { Location: new URL("/", url).toString(), "Set-Cookie": sessionCookie(res.raw) } });
  }
  // Device login (RFC 8628): a machine starts it and polls; a signed-in browser approves it at /device.
  if (req.method === "POST" && url.pathname === "/auth/device") {
    const body = await req.json<{ name?: unknown }>().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 64) return status(400, "name must be 1-64 characters");
    // Unauthenticated and each call stores a row, so budget them per client prefix; never cleared.
    const keys = clientKeys(req);
    if ((await hub.claimAttempt(...keys.map((k) => `device:${k}` as const))) === null) return status(429, "too many attempts");
    // The raw address, shown on the approval page so the owner can spot a request that isn't theirs.
    const ip = (req.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 64);
    const { device_code, user_code } = await hub.createDeviceCode(name, ip);
    const code = `${user_code.slice(0, 4)}-${user_code.slice(4)}`;
    const verification_uri = new URL("/device", url).toString();
    return Response.json({
      device_code, user_code: code, verification_uri,
      verification_uri_complete: `${verification_uri}?code=${code}`,
      expires_in: DEVICE_TTL_MS / 1000, interval: 3,
    });
  }
  if (req.method === "POST" && url.pathname === "/auth/device/token") {
    const body = await req.json<{ device_code?: unknown }>().catch(() => null);
    const deviceCode = typeof body?.device_code === "string" && body.device_code.length <= 64 ? body.device_code : "";
    const res = deviceCode ? await hub.pollDeviceCode(deviceCode) : "expired";
    if (typeof res === "object") return Response.json(res);
    return Response.json({ error: res === "pending" ? "authorization_pending" : "expired_token" }, { status: 400 });
  }

  const authRes = await passkeyRoute(req, env, hub);
  if (authRes) return authRes;

  const session = await readSession(req, env, hub);
  if (!session) {
    if (url.pathname.startsWith("/api/") || url.pathname === "/live") return status(401, "unauthorized");
    if (isWidget(req)) return Response.redirect(new URL("/pair", url).toString(), 302);
    // Back to the page asked for after sign-in (login.html only follows same-origin paths).
    const login = new URL("/login", url);
    if (url.pathname !== "/") login.searchParams.set("next", url.pathname + url.search);
    return Response.redirect(login.toString(), 302);
  }
  if (session.kind === "widget" && !WIDGET_PATHS.has(url.pathname)) return status(403, "forbidden");

  if (url.pathname === "/live") {
    if (req.headers.get("Upgrade") !== "websocket") return status(426, "expected websocket");
    if (!sameOrigin(req)) return status(403, "forbidden origin");
    const headers = new Headers(req.headers);
    headers.set("X-Cession-Session", session.id);
    return hub.fetch(new Request(req, { headers }));
  }

  if (url.pathname === "/api/me") return Response.json({ kind: session.kind });

  if (url.pathname === "/api/sessions") return Response.json(await hub.snapshot());

  if (url.pathname === "/api/history") {
    const by = url.searchParams.get("by") ?? "day";
    const to = Number(url.searchParams.get("to") ?? Date.now());
    const from = Number(url.searchParams.get("from") ?? to - 7 * 86_400_000);
    if ((by !== "day" && by !== "project") || !Number.isFinite(from) || !Number.isFinite(to))
      return status(400, "bad query");
    return Response.json(await hub.history(from, to, by));
  }

  if (req.method === "GET" && url.pathname === "/api/devices")
    return Response.json(await hub.devices(session.id));

  if (req.method === "POST" && url.pathname === "/api/machines") {
    const body = await req.json<{ name?: unknown }>().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 64) return status(400, "name must be 1-64 characters");
    return Response.json({ ...(await hub.createMachineToken(name, session.passkey_id)), url: url.origin });
  }

  if (url.pathname === "/api/device") {
    const code = url.searchParams.get("code") ?? "";
    const request = code.length <= 64 ? await hub.lookupDeviceCode(code) : null;
    return request ? Response.json(request) : status(404, "unknown or expired code");
  }

  if (req.method === "POST" && url.pathname === "/api/device/approve") {
    const body = await req.json<{ code?: unknown }>().catch(() => null);
    const code = typeof body?.code === "string" && body.code.length <= 64 ? body.code : "";
    return code && (await hub.approveDeviceCode(code, session.passkey_id)) ? status(204) : status(404, "unknown or expired code");
  }

  if (req.method === "POST" && url.pathname === "/api/pairing") {
    const { code, expires_at } = await hub.createPairingCode(session.passkey_id);
    return Response.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at });
  }

  const device = req.method === "DELETE" ? url.pathname.match(DEVICE_PATH) : null;
  if (device) {
    const [, kind, id] = device;
    if (!(await hub.revoke(kind as DeviceKind, id))) return status(404, "not found");
    const self = kind === session.kind && id === session.id;
    return new Response(null, { status: 204, headers: self ? { "Set-Cookie": clearCookie() } : {} });
  }

  return env.ASSETS.fetch(req);
}
