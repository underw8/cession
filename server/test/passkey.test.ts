import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SoftAuthenticator } from "./authenticator";
import { BASE, SETUP, assertion, cookieOf, fetchWith, hub, newSession, owner, resetFailures, setupEnv as authEnv, sql, uid } from "./helpers";

function call(path: string, body?: unknown, cookie?: string, e: Env = authEnv, ip?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "vitest" };
  if (cookie) headers.Cookie = `__Host-cession=${cookie}`;
  if (ip) headers["CF-Connecting-IP"] = ip;
  return fetchWith(path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }, e);
}

async function register(auth: SoftAuthenticator, body: object = { setup_code: SETUP }, cookie?: string) {
  const opts = await call("/auth/register/options", body, cookie);
  expect(opts.status).toBe(200);
  return { response: await auth.register((await opts.json()) as PublicKeyCredentialCreationOptionsJSON, BASE) };
}

const login = async (auth: SoftAuthenticator, ip?: string) =>
  call("/auth/login/verify", { response: await assertion(auth, ip) }, undefined, authEnv, ip);

const counterOf = (id: string) =>
  sql<{ counter: number }>("SELECT counter FROM passkeys WHERE id = ?", id).then(([r]) => r.counter);

beforeEach(resetFailures);
afterEach(resetFailures); // the global-ceiling tests must not leave other files locked

describe("passkeys", () => {
  it("soft authenticator registers and logs in", async () => {
    const auth = await SoftAuthenticator.create();
    const body = await register(auth);
    const reg = await call("/auth/register/verify", body);
    expect(reg.status).toBe(204);
    const first = cookieOf(reg);
    expect(first).toBeTruthy();
    expect((await call("/api/sessions", undefined, first)).status).toBe(200);
    expect(await counterOf(body.response.id)).toBe(0);

    const res = await login(auth);
    expect(res.status).toBe(204);
    const second = cookieOf(res);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await call("/api/sessions", undefined, second)).status).toBe(200);
    expect(await counterOf(body.response.id)).toBe(1);
  });

  it("rejects a wrong setup code with 401", async () => {
    expect((await call("/auth/register/options", { setup_code: "nope" })).status).toBe(401);
  });

  it("locks setup after 10 wrong codes, even for the right one", async () => {
    for (let i = 0; i < 10; i++) await call("/auth/register/options", { setup_code: "nope" });
    expect((await call("/auth/register/options", { setup_code: SETUP })).status).toBe(429);
  });

  it("lets at most 10 of 30 parallel wrong setup codes from one IP past the lock", async () => {
    const res = await Promise.all(Array.from({ length: 30 }, () => call("/auth/register/options", { setup_code: "nope" }, undefined, authEnv, "192.0.2.9")));
    expect(res.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(10);
  });

  it("locks setup per IP: 10 failures from one IP don't lock another", async () => {
    for (let i = 0; i < 10; i++) await call("/auth/register/options", { setup_code: "nope" }, undefined, authEnv, "192.0.2.10");
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "192.0.2.10")).status).toBe(429);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "192.0.2.11")).status).toBe(200);
  });

  it("locks setup per IPv6 /64, not per address", async () => {
    for (let i = 0; i < 10; i++) await call("/auth/register/options", { setup_code: "nope" }, undefined, authEnv, `2001:db8:1:2::${i.toString(16)}`);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "2001:DB8:1:2:ffff:0:0:1")).status).toBe(429);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "2001:db8:1:3::1")).status).toBe(200);
  });

  it("locks setup per IPv6 /48 after 100 failures across its /64s, leaving other prefixes open", async () => {
    for (let i = 0; i < 100; i++) await call("/auth/register/options", { setup_code: "nope" }, undefined, authEnv, `2001:db8:7:${i.toString(16)}::1`);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "2001:db8:7:ffff::1")).status).toBe(429);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "2001:db8:8::1")).status).toBe(200);
  });

  it("has no global setup ceiling: 100 failures across IPs don't lock a fresh IP", async () => {
    for (let i = 0; i < 100; i++) await call("/auth/register/options", { setup_code: "nope" }, undefined, authEnv, `198.51.100.${i}`);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "203.0.113.1")).status).toBe(200);
  });

  it("rejects an oversized setup code with 400 before it is hashed or counted", async () => {
    for (let i = 0; i < 12; i++) expect((await call("/auth/register/options", { setup_code: "x".repeat(257) }, undefined, authEnv, "192.0.2.40")).status).toBe(400);
    expect((await call("/auth/register/options", { setup_code: SETUP }, undefined, authEnv, "192.0.2.40")).status).toBe(200);
  });

  it("removing a passkey ends every session, token and pairing code that descends from it", async () => {
    const { auth, id, cookie: first } = await owner();
    const second = cookieOf(await login(auth))!;
    const { token } = (await (await call("/api/machines", { name: "m", assertion: await assertion(auth) }, first)).json()) as { token: string };
    const { code } = (await (await call("/api/pairing", { assertion: await assertion(auth) }, first)).json()) as { code: string };
    const pending = (await (await call("/api/pairing", { assertion: await assertion(auth) }, first)).json()) as { code: string };
    const widget = await hub().redeemPairingCode(code, "w", "192.0.2.50");
    expect(widget.status).toBe("ok");
    const other = await newSession("browser", "other");
    const remove = { method: "DELETE", headers: { Cookie: `__Host-cession=${other}` }, body: JSON.stringify({ assertion: await assertion(auth) }) };
    expect((await fetchWith(`/api/devices/passkey/${id}`, remove)).status).toBe(204);
    for (const raw of [first, second, (widget as { raw: string }).raw]) expect(await hub().getSession(raw)).toBeNull();
    expect(await hub().checkMachineToken(token)).toBe(false);
    expect((await hub().redeemPairingCode(pending.code, "w", "192.0.2.51")).status).toBe("bad");
    expect((await call("/api/sessions", undefined, other)).status).toBe(200);
  });

  it("needs a fresh assertion to remove a passkey", async () => {
    const { auth, id, cookie } = await owner();
    const remove = (body?: unknown) =>
      fetchWith(`/api/devices/passkey/${id}`, { method: "DELETE", headers: { Cookie: `__Host-cession=${cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) }, authEnv);
    const bare = await remove();
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe("reauthenticate");
    expect((await remove({ assertion: await assertion(await SoftAuthenticator.create()) })).status).toBe(401);
    expect(await hub().getPasskey(id)).not.toBeNull();
    expect((await remove({ assertion: await assertion(auth) })).status).toBe(204);
    expect(await hub().getPasskey(id)).toBeNull();
  });

  it("ties credentials to the passkey that signed the step-up, not the session's", async () => {
    const { auth: a, cookie } = await owner();
    const b = await SoftAuthenticator.create();
    const added = await register(b, { assertion: await assertion(a) }, cookie);
    expect((await call("/auth/register/verify", added, cookie)).status).toBe(204);
    const bId = added.response.id;

    const { token } = (await (await call("/api/machines", { name: "m", assertion: await assertion(b) }, cookie)).json()) as { token: string };
    const { code } = (await (await call("/api/pairing", { assertion: await assertion(b) }, cookie)).json()) as { code: string };
    const { device_code, user_code } = await hub().createDeviceCode(uid("mac"), "192.0.2.91");
    expect((await call("/api/device/approve", { code: user_code, assertion: await assertion(b) }, cookie)).status).toBe(204);

    expect(await hub().revoke("passkey", bId)).toBe(true);
    expect(await hub().checkMachineToken(token)).toBe(false);
    expect((await hub().redeemPairingCode(code, "w", "192.0.2.92")).status).toBe("bad");
    expect(await hub().pollDeviceCode(device_code)).toBe("expired");
    expect(await hub().getSession(cookie)).not.toBeNull();
  });

  it("creates nothing descending from a passkey once it is removed", async () => {
    const { id } = await owner();
    const { user_code } = await hub().createDeviceCode(uid("mac"), "192.0.2.90");
    expect(await hub().revoke("passkey", id)).toBe(true);
    expect(await hub().createMachineToken("m", id)).toBeNull();
    expect(await hub().createPairingCode(id)).toBeNull();
    expect(await hub().createSession("browser", "b", id)).toBeNull();
    expect(await hub().approveDeviceCode(user_code, id)).toBe(false);
  });

  it("answers a JSON null body with 400, not 500", async () => {
    for (const path of ["/auth/register/verify", "/auth/login/verify"]) {
      const res = await fetchWith(path, { method: "POST", body: "null" });
      expect(res.status).toBe(400);
    }
  });

  it("refuses setup when SETUP_CODE is shorter than 32 characters", async () => {
    const weak = "0123456789abcdef0123456789abcde";
    const res = await call("/auth/register/options", { setup_code: weak }, undefined, { ...authEnv, SETUP_CODE: weak });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("SETUP_CODE must be at least 32 characters");
  });

  it("issues a 400-day __Host- cookie; the server decides expiry", async () => {
    const res = await call("/auth/register/verify", await register(await SoftAuthenticator.create()));
    const raw = cookieOf(res);
    expect(res.headers.get("Set-Cookie")).toBe(`__Host-cession=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`);
  });

  it("rejects a replayed register verify", async () => {
    const body = await register(await SoftAuthenticator.create());
    expect((await call("/auth/register/verify", body)).status).toBe(204);
    expect([400, 401]).toContain((await call("/auth/register/verify", body)).status);
  });

  it("rejects login with an unknown passkey", async () => {
    expect((await login(await SoftAuthenticator.create())).status).toBe(401);
  });

  it("lets a signed-in browser add a passkey without the setup code after a fresh assertion", async () => {
    const { auth, cookie } = await owner();
    const body = await register(await SoftAuthenticator.create(), { assertion: await assertion(auth) }, cookie);
    const res = await call("/auth/register/verify", body, cookie);
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses to add a passkey from a signed-in browser without a valid fresh assertion", async () => {
    const { cookie } = await owner();
    const bare = await call("/auth/register/options", {}, cookie);
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe("reauthenticate");
    const stranger = await assertion(await SoftAuthenticator.create());
    expect((await call("/auth/register/options", { assertion: stranger }, cookie)).status).toBe(401);
  });

  it("does not let a widget session skip the setup code", async () => {
    const raw = await newSession("widget", "w");
    expect((await call("/auth/register/options", {}, raw)).status).toBe(401);
  });

  it("does not lock login after failed assertions, so a neighbour can't lock the owner out", async () => {
    const { auth } = await owner();
    for (let i = 0; i < 12; i++) expect((await login(await SoftAuthenticator.create(), "192.0.2.1")).status).toBe(401);
    expect((await login(auth, "192.0.2.1")).status).toBe(204);
  });

  it("limits login options to 100 per IPv6 /48 across its /64s", async () => {
    for (let i = 0; i < 100; i++) expect((await call("/auth/login/options", {}, undefined, authEnv, `2001:db8:9:${i.toString(16)}::1`)).status).toBe(200);
    expect((await call("/auth/login/options", {}, undefined, authEnv, "2001:db8:9:ffff::1")).status).toBe(429);
    expect((await call("/auth/login/options", {}, undefined, authEnv, "2001:db8:a::1")).status).toBe(200);
  });

  it("limits login options to 30 per IP per 10 minutes", async () => {
    for (let i = 0; i < 30; i++) expect((await call("/auth/login/options", {}, undefined, authEnv, "192.0.2.20")).status).toBe(200);
    expect((await call("/auth/login/options", {}, undefined, authEnv, "192.0.2.20")).status).toBe(429);
    expect((await call("/auth/login/options", {}, undefined, authEnv, "192.0.2.21")).status).toBe(200);
  });

  it("rejects malformed or oversized login bodies with 400", async () => {
    const huge = { id: "x".repeat(2049), response: { clientDataJSON: "e30" } };
    for (const body of [{}, { response: null }, { response: "x" }, { response: { id: 1 } }, { response: { id: "a", response: {} } }, { response: huge }])
      expect((await call("/auth/login/verify", body)).status).toBe(400);
  });

  it("rejects register options with no session when SETUP_CODE is unset", async () => {
    const res = await call("/auth/register/options", { setup_code: SETUP }, undefined, { ...authEnv, SETUP_CODE: undefined });
    expect(res.status).toBe(401);
  });

  it("logout revokes the session and clears the cookie", async () => {
    const raw = await newSession("browser", "b");
    const res = await call("/auth/logout", {}, raw);
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-cession=; .*Max-Age=0$/);
    expect(await hub().getSession(raw)).toBeNull();
  });
});
