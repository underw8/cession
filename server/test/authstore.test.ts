import { describe, expect, it } from "vitest";
import { hub, resetFailures as reset, sql, uid } from "./helpers";

describe("machine tokens", () => {
  it("issues a cs_-prefixed token, verifies it, and rejects a tampered one", async () => {
    const { token } = await hub().createMachineToken("mini");
    expect(token.startsWith("cs_")).toBe(true);
    expect(await hub().checkMachineToken(token)).toBe(true);
    expect(await hub().checkMachineToken(`${token}x`)).toBe(false);

    const machines = (await hub().devices(null)).machines;
    const mine = machines.find((m) => m.name === "mini");
    expect(mine?.last_used).not.toBeNull();
  });

  it("stores the token hashed, never raw", async () => {
    const { token } = await hub().createMachineToken(uid("name"));
    const rows = await sql<{ hash: string }>("SELECT hash FROM machine_tokens");
    for (const row of rows) expect(row.hash).not.toBe(token);
  });
});

describe("sessions", () => {
  it("creates a widget session, reads its kind, then revokes it", async () => {
    const raw = await hub().createSession("widget", "w");
    const session = await hub().getSession(raw);
    expect(session?.kind).toBe("widget");

    expect(await hub().revoke("widget", session!.id)).toBe(true);
    expect(await hub().getSession(raw)).toBeNull();
  });

  it("treats an expired session as absent", async () => {
    const label = uid("expired");
    const raw = await hub().createSession("browser", label);
    await sql("UPDATE auth_sessions SET expires_at = 0 WHERE label = ?", label);
    expect(await hub().getSession(raw)).toBeNull();
  });

  it("deletes expired sessions when creating one", async () => {
    const label = uid("old");
    await hub().createSession("browser", label);
    await sql("UPDATE auth_sessions SET expires_at = 0 WHERE label = ?", label);
    await hub().createSession("browser", uid("new"));
    expect(await sql("SELECT 1 FROM auth_sessions WHERE label = ?", label)).toHaveLength(0);
  });

  it("refuses a /live upgrade for a session revoked after the gate", async () => {
    const live = (session: string) => hub().fetch("http://localhost/live", { headers: { Upgrade: "websocket", "X-Cession-Session": session } });
    expect((await live("revoked-id")).status).toBe(401);
    const raw = await hub().createSession("widget", "w");
    const res = await live((await hub().getSession(raw))!.id);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

describe("pairing codes", () => {
  it("redeems a lowercase, dashed code once into a widget session", async () => {
    const { code } = await hub().createPairingCode();
    const dashed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

    const res = await hub().redeemPairingCode(dashed, "paired widget", "a");
    expect(res.status).toBe("ok");
    expect((await hub().getSession(res.status === "ok" ? res.raw : ""))?.kind).toBe("widget");

    expect(await hub().redeemPairingCode(dashed, "paired widget", "a")).toEqual({ status: "bad" });
  });

  it("rejects a code past its expiry", async () => {
    const { code } = await hub().createPairingCode();
    await sql("UPDATE pairing_codes SET expires_at = 0");
    expect(await hub().redeemPairingCode(code, "late", "a")).toEqual({ status: "bad" });
  });
});

describe("challenges", () => {
  it("is single use and purpose-specific", async () => {
    const challenge = uid("chal");
    await hub().putChallenge(challenge, "register");
    expect(await hub().takeChallenge(challenge, "register")).toBe(true);
    expect(await hub().takeChallenge(challenge, "register")).toBe(false);

    const other = uid("chal");
    await hub().putChallenge(other, "register");
    expect(await hub().takeChallenge(other, "login")).toBe(false);
  });

  it("prunes expired challenges when issuing one", async () => {
    const old = uid("chal");
    await hub().putChallenge(old, "login");
    await sql("UPDATE challenges SET expires_at = 0 WHERE challenge = ?", old);
    await hub().putChallenge(uid("chal"), "login");
    expect(await sql("SELECT 1 FROM challenges WHERE challenge = ?", old)).toHaveLength(0);
  });
});

describe("lockout", () => {

  it("locks a key after 10 failures within the window, independent of other keys", async () => {
    await reset();
    for (let i = 0; i < 9; i++) expect(await hub().trySetupCode("nope", "right", "a")).toBe("bad");
    expect(await hub().locked("setup:a")).toBe(false);
    expect(await hub().trySetupCode("nope", "right", "a")).toBe("bad");
    expect(await hub().locked("setup:a")).toBe(true);
    expect(await hub().trySetupCode("right", "right", "a")).toBe("locked");
    expect(await hub().trySetupCode("right", "right", "b")).toBe("ok");
    expect(await hub().locked("pair:a")).toBe(false);
  });

  it("does not count a correct setup code as a failure", async () => {
    await reset();
    for (let i = 0; i < 12; i++) expect(await hub().trySetupCode("right", "right", "a")).toBe("ok");
  });

  it("rejects setup codes of a different length", async () => {
    await reset();
    expect(await hub().trySetupCode("right-and-more", "right", "a")).toBe("bad");
    expect(await hub().trySetupCode("", "right", "a")).toBe("bad");
  });
});
