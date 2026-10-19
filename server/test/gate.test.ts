import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { BASE, asIncoming, authEnv as devEnv, fetchWith as fetchUnauthenticated, hub, machineToken, resetFailures, newSession } from "./helpers";

// Verifies the router enforces the session gate on every read route and never on ingest.

const fetchAs = (raw: string, path: string, init: RequestInit = {}) =>
  fetchUnauthenticated(path, { ...init, headers: { ...init.headers, Cookie: `__Host-cession=${raw}` } });

describe("session gate (DEV_SKIP_AUTH unset)", () => {
  it.each(["/api/sessions", "/api/history"])("GET %s without a session returns 401", async (path) => {
    expect((await fetchUnauthenticated(path)).status).toBe(401);
  });

  it("GET /api/sessions with a malformed session cookie returns 401", async () => {
    const res = await fetchUnauthenticated("/api/sessions", { headers: { Cookie: "__Host-cession=too-short" } });
    expect(res.status).toBe(401);
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
    const raw = await newSession("widget", "w");
    expect((await fetchAs(raw, "/api/sessions")).status).toBe(200);
    expect(await (await fetchAs(raw, "/api/me")).json()).toEqual({ kind: "widget" });
    expect((await fetchAs(raw, "/api/devices")).status).toBe(403);
    expect((await fetchAs(raw, "/api/machines", { method: "POST", headers: { Origin: BASE } })).status).toBe(403);
    expect((await fetchAs(raw, "/devices")).status).toBe(403);
    expect((await fetchAs(raw, "/api/pairing", { method: "POST", headers: { Origin: BASE } })).status).toBe(403);
    expect((await fetchAs(raw, "/api/devices/machine/x", { method: "DELETE", headers: { Origin: BASE } })).status).toBe(403);
  });

  it("reports a browser session as browser", async () => {
    const raw = await newSession("browser", "b");
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
  const pair = (origin?: string) =>
    fetchUnauthenticated("/auth/pair", {
      method: "POST",
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=WRONG-CODE",
    });

  it("rejects a cross-origin POST to a normal route", async () => {
    const raw = await newSession("browser", "b");
    const evil = { method: "POST", headers: { Origin: "https://evil.test" } };
    expect((await fetchAs(raw, "/api/machines", evil)).status).toBe(403);
  });

  it.each(["https://evil.test", "https://evil.example", "null"])("rejects /auth/pair with Origin %j", async (origin) => {
    expect((await pair(origin)).status).toBe(403);
  });

  it.each([undefined, BASE, "tauri://localhost"])("still routes /auth/pair with Origin %j", async (origin) => {
    await resetFailures();
    const res = await pair(origin);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/\/pair\?error=1$/);
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
    const raw = await newSession("browser", "b");
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

  it("does not spend the /auth/* budget on GET requests", async () => {
    const get = () =>
      worker.fetch(asIncoming(new Request("https://cession.example.com/auth/device/token", {
        headers: { "CF-Connecting-IP": "198.51.100.211" },
      })), devEnv);
    for (let i = 0; i < 65; i++) expect((await get()).status).not.toBe(429);
  });
});

describe("gate rate limit", () => {
  const stub = (success: boolean) => ({ ...devEnv, GATE_LIMITER: { limit: async () => ({ success }) } }) as unknown as Env;

  it.each(["/login", "/auth/device/token"])(
    "answers 429 for GET %s on a deployed host once the shared budget is spent",
    async (path) => {
      const res = await worker.fetch(asIncoming(new Request(`https://cession.example.com${path}`)), stub(false));
      expect(res.status).toBe(429);
    },
  );

  it("does not spend the shared budget on a POST /auth/* request or on localhost", async () => {
    const overBudget = stub(false);
    const authRes = await worker.fetch(asIncoming(new Request("https://cession.example.com/auth/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    })), overBudget);
    expect(authRes.status).not.toBe(429);
    const localRes = await worker.fetch(asIncoming(new Request(`${BASE}/login`)), overBudget);
    expect(localRes.status).not.toBe(429);
  });

  it("the real binding enforces its configured 1200/min limit", async () => {
    let last = { success: true };
    for (let i = 0; i < 1201; i++) last = await devEnv.GATE_LIMITER.limit({ key: "gate-limit-config-check" });
    expect(last.success).toBe(false);
  });
});
