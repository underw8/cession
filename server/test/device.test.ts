import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertion, cookieOf, fetchWith, hub, newSession, owner, resetFailures, sql, uid } from "./helpers";

const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const start = (name = uid("mac"), ip = "192.0.2.70") =>
  fetchWith("/auth/device", json({ name }, { "CF-Connecting-IP": ip }));
const poll = (device_code: string) => fetchWith("/auth/device/token", json({ device_code }));
const as = (cookie: string, path: string, init: RequestInit = {}) =>
  fetchWith(path, { ...init, headers: { ...init.headers, Cookie: `__Host-cession=${cookie}` } });

type Started = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval: number };

beforeEach(resetFailures);
afterEach(resetFailures);

describe("device login", () => {
  it("issues a token once a browser approves the code, exactly once", async () => {
    const name = uid("mac");
    const s = (await (await start(name)).json()) as Started;
    expect(s.user_code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(s.verification_uri_complete).toBe(`http://localhost/device?code=${s.user_code}`);

    expect(await (await poll(s.device_code)).json()).toEqual({ error: "authorization_pending" });

    const { auth, id, cookie: browser } = await owner();
    expect(await (await as(browser, `/api/device?code=${s.user_code}`)).json()).toMatchObject({ name, ip: "192.0.2.70" });
    const bare = await as(browser, "/api/device/approve", json({ code: s.user_code }));
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe("reauthenticate");
    expect((await as(browser, "/api/device/approve", json({ code: s.user_code, assertion: await assertion(auth) }))).status).toBe(204);

    const res = await poll(s.device_code);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(await hub().checkMachineToken(token)).toBe(true);
    // The token descends from the approving session's passkey, so removing it revokes the machine.
    expect(await sql("SELECT 1 FROM machine_tokens WHERE name = ? AND passkey_id = ?", name, id)).toHaveLength(1);

    expect(await (await poll(s.device_code)).json()).toEqual({ error: "expired_token" });
    expect((await as(browser, "/api/device/approve", json({ code: s.user_code, assertion: await assertion(auth) }))).status).toBe(404);
  });

  it("needs a browser session to look up or approve a code", async () => {
    const s = (await (await start()).json()) as Started;
    expect((await fetchWith(`/api/device?code=${s.user_code}`)).status).toBe(401);
    const widget = await newSession("widget", "w");
    expect((await as(widget, "/api/device/approve", json({ code: s.user_code }))).status).toBe(403);
    expect(await (await poll(s.device_code)).json()).toEqual({ error: "authorization_pending" });
  });

  it("expires codes after their lifetime", async () => {
    const s = (await (await start()).json()) as Started;
    await sql("UPDATE device_codes SET expires_at = 0");
    const { auth, cookie: browser } = await owner();
    expect((await as(browser, "/api/device/approve", json({ code: s.user_code, assertion: await assertion(auth) }))).status).toBe(404);
    expect(await (await poll(s.device_code)).json()).toEqual({ error: "expired_token" });
  });

  it("answers an unknown or malformed device code as expired", async () => {
    expect(await (await poll("nope")).json()).toEqual({ error: "expired_token" });
    expect(await (await poll("x".repeat(65))).json()).toEqual({ error: "expired_token" });
    expect(await (await fetchWith("/auth/device/token", json(null))).json()).toEqual({ error: "expired_token" });
  });

  it("rejects a missing or overlong machine name", async () => {
    expect((await fetchWith("/auth/device", json({}))).status).toBe(400);
    expect((await start("x".repeat(65))).status).toBe(400);
  });

  it("budgets device logins per client", async () => {
    for (let i = 0; i < 10; i++) expect((await start(undefined, "192.0.2.80")).status).toBe(200);
    expect((await start(undefined, "192.0.2.80")).status).toBe(429);
    expect((await start(undefined, "192.0.2.81")).status).toBe(200);
  });

  it("sends a signed-out browser to sign in, then back to the page it asked for", async () => {
    const res = await fetchWith("/device?code=ABCD-EFGH");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost/login?next=%2Fdevice%3Fcode%3DABCD-EFGH");
    expect(cookieOf(res)).toBeUndefined();
  });
});
