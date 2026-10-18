import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { BASE, asIncoming, authEnv as devEnv, fetchWith as fetchUnauthenticated, hub, machineToken, resetFailures } from "./helpers";

// Verifies the router enforces the session gate on every read route and never on ingest.

const fetchAs = (raw: string, path: string, init: RequestInit = {}) =>
  fetchUnauthenticated(path, { ...init, headers: { ...init.headers, Cookie: `__Host-cession=${raw}` } });

describe("session gate (DEV_SKIP_AUTH unset)", () => {
  it.each(["/api/sessions", "/api/history"])("GET %s without a session returns 401", async (path) => {
    expect((await fetchUnauthenticated(path)).status).toBe(401);
  });

  it("GET /live without a session returns 401", async () => {
    const res = await fetchUnauthenticated("/live", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("GET / redirects a browser to /login", async () => {
    const res = await fetchUnauthenticated("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/\/login$/);
  });

  it("GET / redirects the widget to /pair", async () => {
    const res = await fetchUnauthenticated("/", { headers: { "User-Agent": "Mozilla/5.0 cession-widget" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/\/pair$/);
  });

  it("GET /login is public", async () => {
    expect((await fetchUnauthenticated("/login")).status).toBe(200);
  });

  it("does not gate ingest: POST /events still reaches validation with 400", async () => {
    const res = await fetchUnauthenticated("/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${await machineToken()}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("widget session scope", () => {
  it("reads the dashboard API but not browser-only routes", async () => {
    const raw = await hub().createSession("widget", "w");
    expect((await fetchAs(raw, "/api/sessions")).status).toBe(200);
    expect(await (await fetchAs(raw, "/api/me")).json()).toEqual({ kind: "widget" });
    expect((await fetchAs(raw, "/api/devices")).status).toBe(403);
    expect((await fetchAs(raw, "/api/machines", { method: "POST", headers: { Origin: BASE } })).status).toBe(403);
    expect((await fetchAs(raw, "/devices")).status).toBe(403);
    expect((await fetchAs(raw, "/api/pairing", { method: "POST", headers: { Origin: BASE } })).status).toBe(403);
    expect((await fetchAs(raw, "/api/devices/machine/x", { method: "DELETE", headers: { Origin: BASE } })).status).toBe(403);
  });

  it("reports a browser session as browser", async () => {
    const raw = await hub().createSession("browser", "b");
    expect(await (await fetchAs(raw, "/api/me")).json()).toEqual({ kind: "browser" });
  });
});

describe("DEV_SKIP_AUTH is scoped to localhost", () => {
  it("does not bypass auth for a deployed hostname even with DEV_SKIP_AUTH=1", async () => {
    const skipEnv = { ...env, DEV_SKIP_AUTH: "1" } as unknown as Env;
    const req = new Request("https://cession.example.com/api/sessions", { redirect: "manual" });
    expect((await worker.fetch(asIncoming(req), skipEnv)).status).toBe(401);
  });
});

describe("CSRF origin check", () => {
  it("rejects a cross-origin POST except /auth/pair", async () => {
    await resetFailures();
    const raw = await hub().createSession("browser", "b");
    const evil = { method: "POST", headers: { Origin: "https://evil.test" } };
    expect((await fetchAs(raw, "/api/machines", evil)).status).toBe(403);
    const pair = await fetchAs(raw, "/auth/pair", {
      ...evil,
      headers: { ...evil.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=WRONG-CODE",
    });
    expect(pair.status).toBe(303);
    expect(pair.headers.get("Location")).toMatch(/\/pair\?error=1$/);
  });
});

describe("security headers", () => {
  const csp = (connect: string) =>
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  const expectHeaders = (res: Response, https = false) => {
    expect(res.headers.get("Content-Security-Policy")).toBe(
      https ? csp("'self' wss://cession.example.com") : csp("'self' wss://localhost ws://localhost"),
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toBe(https ? "max-age=31536000" : null);
  };

  it("sets them on a gated page, /login, a redirect and an API 401", async () => {
    const raw = await hub().createSession("browser", "b");
    const page = await fetchAs(raw, "/");
    expect(page.status).toBe(200);
    expectHeaders(page);
    const login = await fetchUnauthenticated("/login");
    expect(login.status).toBe(200);
    expectHeaders(login);
    const redirect = await fetchUnauthenticated("/");
    expect(redirect.status).toBe(302);
    expectHeaders(redirect);
    const api = await fetchUnauthenticated("/api/sessions");
    expect(api.status).toBe(401);
    expectHeaders(api);
  });

  it("adds HSTS only over https", async () => {
    const res = await worker.fetch(asIncoming(new Request("https://cession.example.com/api/sessions")), devEnv);
    expect(res.status).toBe(401);
    expectHeaders(res, true);
  });

  it("turns a thrown error into a 500 that still carries the headers", async () => {
    const broken = { ...devEnv, HUB: { idFromName: () => { throw new Error("boom"); } } } as unknown as Env;
    const res = await worker.fetch(asIncoming(new Request(`${BASE}/api/sessions`)), broken);
    expect(res.status).toBe(500);
    expectHeaders(res);
  });
});

describe("auth rate limit", () => {
  it("answers 429 once a client exceeds the /auth/* budget on a deployed host", async () => {
    const poll = () =>
      worker.fetch(asIncoming(new Request("https://cession.example.com/auth/device/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.200" },
        body: JSON.stringify({ device_code: "nope" }),
      })), devEnv);
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) codes.push((await poll()).status);
    expect(codes.slice(0, 60).every((c) => c === 400)).toBe(true);
    expect(codes).toContain(429);
  });
});
