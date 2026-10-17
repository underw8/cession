import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, cookieOf, fetchWith, hub, resetFailures, uid } from "./helpers";

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", `__Host-cession=${init.cookie}`);
  return fetchWith(path, { ...init, headers });
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ingest = (token: string) =>
  call("/events", { ...json({ session_id: uid(), event: "SessionStart", ts: Date.now() }), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
const pair = (code: string, ip = "192.0.2.1") =>
  call("/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "tauri://localhost", "CF-Connecting-IP": ip },
    body: new URLSearchParams({ code }).toString(),
  });

beforeEach(resetFailures);
afterEach(resetFailures); // the global-ceiling tests must not leave other files locked

describe("devices", () => {
  it("creates a machine token that ingests until revoked", async () => {
    const browser = await hub().createSession("browser", "b");
    const res = await call("/api/machines", { ...json({ name: "  work-mbp  " }), cookie: browser });
    expect(res.status).toBe(200);
    const { id, token, url } = (await res.json()) as { id: string; token: string; url: string };
    expect(url).toBe(BASE);
    expect((await ingest(token)).status).toBe(204);

    const list = (await (await call("/api/devices", { cookie: browser })).json()) as { machines: { id: string; name: string }[] };
    expect(list.machines).toContainEqual(expect.objectContaining({ id, name: "work-mbp" }));

    expect((await call(`/api/devices/machine/${id}`, { method: "DELETE", cookie: browser })).status).toBe(204);
    expect((await ingest(token)).status).toBe(401);
    expect((await call(`/api/devices/machine/${id}`, { method: "DELETE", cookie: browser })).status).toBe(404);
  });

  it.each(["", "   ", "x".repeat(65)])("rejects machine name %j with 400", async (name) => {
    const browser = await hub().createSession("browser", "b");
    expect((await call("/api/machines", { ...json({ name }), cookie: browser })).status).toBe(400);
  });

  it("revoking the current browser session clears its cookie", async () => {
    const browser = await hub().createSession("browser", "b");
    const { browsers } = (await (await call("/api/devices", { cookie: browser })).json()) as { browsers: { id: string; current: boolean }[] };
    const me = browsers.find((b) => b.current)!;
    const res = await call(`/api/devices/browser/${me.id}`, { method: "DELETE", cookie: browser });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-cession=; .*Max-Age=0$/);
    expect((await call("/api/sessions", { cookie: browser })).status).toBe(401);
  });
});

describe("pairing", () => {
  it("pairs a widget end to end, single use", async () => {
    const browser = await hub().createSession("browser", "b");
    const res = await call("/api/pairing", { method: "POST", cookie: browser });
    const { code, expires_at } = (await res.json()) as { code: string; expires_at: number };
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(expires_at).toBeGreaterThan(Date.now());

    const ok = await pair(code.toLowerCase());
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get("Location")!).pathname).toBe("/");
    const widget = cookieOf(ok)!;
    expect(await (await call("/api/me", { cookie: widget })).json()).toEqual({ kind: "widget" });

    const again = await pair(code);
    expect(again.status).toBe(303);
    expect(again.headers.get("Location")).toMatch(/\/pair\?error=1$/);
  });

  it("locks pairing after 10 bad attempts, even for a valid code", async () => {
    const { code } = await hub().createPairingCode();
    for (let i = 0; i < 10; i++) await pair("WRONG-CODE");
    expect((await pair(code)).status).toBe(429);
  });

  it("lets at most 10 of 30 parallel wrong codes from one IP past the lock", async () => {
    const res = await Promise.all(Array.from({ length: 30 }, () => pair("WRONG-CODE")));
    expect(res.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(10);
  });

  it("locks pairing per IP: 10 failures from one IP don't lock another", async () => {
    const { code } = await hub().createPairingCode();
    for (let i = 0; i < 10; i++) await pair("WRONG-CODE", "192.0.2.30");
    expect((await pair(code, "192.0.2.30")).status).toBe(429);
    expect((await pair(code, "192.0.2.31")).status).toBe(303);
  });

  it("has no global pairing ceiling: 100 failures across IPs don't lock a fresh IP", async () => {
    const { code } = await hub().createPairingCode();
    for (let i = 0; i < 100; i++) await pair("WRONG-CODE", `198.51.100.${i}`);
    expect((await pair(code, "203.0.113.1")).status).toBe(303);
  });

  it("locks pairing per IPv6 /48 after 100 failures across its /64s", async () => {
    const { code } = await hub().createPairingCode();
    for (let i = 0; i < 100; i++) await pair("WRONG-CODE", `2001:db8:5:${i.toString(16)}::1`);
    expect((await pair(code, "2001:db8:5:ffff::1")).status).toBe(429);
    expect((await pair(code, "2001:db8:6::1")).status).toBe(303);
  });

  it("revoking a widget closes its socket and its cookie stops working", async () => {
    const browser = await hub().createSession("browser", "b");
    const widget = await hub().createSession("widget", "Widget");
    const res = await call("/live", { headers: { Upgrade: "websocket" }, cookie: widget });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    ws.accept();

    const { widgets } = (await (await call("/api/devices", { cookie: browser })).json()) as { widgets: { id: string }[] };
    const id = widgets.at(-1)!.id;
    expect((await call(`/api/devices/widget/${id}`, { method: "DELETE", cookie: browser })).status).toBe(204);
    await expect(closed).resolves.toBe(4001);

    expect((await call("/live", { headers: { Upgrade: "websocket" }, cookie: widget })).status).toBe(401);
  });
});
