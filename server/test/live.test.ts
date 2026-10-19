import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { describe, expect, it, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Snapshot } from "../src/hub";
import { SoftAuthenticator } from "./authenticator";
import { BASE, authEnv as baseEnv, cookieOf, fetchWith, get, post, uid, hub } from "./helpers";

const SETUP = "s3tup-0123456789abcdef0123456789abcdef";
const authEnv = { ...baseEnv, SETUP_CODE: SETUP } as Env;

/** Registers a fresh passkey-backed browser session, bypassing DEV_SKIP_AUTH. */
async function browserSession(): Promise<{ passkeyId: string; cookie: string }> {
  const auth = await SoftAuthenticator.create();
  const label = uid("live-auth");
  const optsRes = await fetchWith(
    "/auth/register/options",
    { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": label }, body: JSON.stringify({ setup_code: SETUP }) },
    authEnv,
  );
  expect(optsRes.status).toBe(200);
  const response = await auth.register((await optsRes.json()) as PublicKeyCredentialCreationOptionsJSON, BASE);
  const verifyRes = await fetchWith(
    "/auth/register/verify",
    { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": label }, body: JSON.stringify({ response }) },
    authEnv,
  );
  expect(verifyRes.status).toBe(204);
  return { passkeyId: response.id, cookie: cookieOf(verifyRes)! };
}

async function connectAuthed(cookie: string) {
  const res = await fetchWith("/live", { headers: { Upgrade: "websocket", Cookie: `__Host-cession=${cookie}` } }, authEnv);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

async function connect() {
  const res = await get("/live", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const messages: Snapshot[] = [];
  ws.addEventListener("message", (e) => { if (e.data !== "pong") messages.push(JSON.parse(e.data as string)); });
  return { ws, messages };
}

describe("GET /live", () => {
  it("sends a snapshot on connect and after each event", async () => {
    const { ws, messages } = await connect();
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    const id = uid();
    await post("/events", { session_id: id, event: "UserPromptSubmit", ts: Date.now() });
    await vi.waitFor(() =>
      expect(messages.at(-1)?.sessions.find((s) => s.id === id)?.status).toBe("working"),
    );
    ws.close();
  });

  it("answers ping with pong, so clients can detect a silently dead socket", async () => {
    const { ws } = await connect();
    const pong = new Promise<string>((resolve) =>
      ws.addEventListener("message", (e) => { if (e.data === "pong") resolve(e.data); }));
    ws.send("ping");
    await expect(pong).resolves.toBe("pong");
    ws.close();
  });

  it("rejects a non-WebSocket request with 426", async () => {
    expect((await get("/live")).status).toBe(426);
  });

  it("rejects a cross-origin upgrade with 403", async () => {
    const res = await get("/live", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin upgrade", async () => {
    const res = await get("/live", { headers: { Upgrade: "websocket", Origin: "http://localhost" } });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("closes sockets older than the TTL on the next broadcast", async () => {
    const { ws, messages } = await connect();
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    await runInDurableObject(hub(), (_i, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ openedAt: 0 });
    });

    const closePromise = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
    });

    const id = uid();
    await post("/events", { session_id: id, event: "UserPromptSubmit", ts: Date.now() });
    await vi.waitFor(() => closePromise);

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("closes sockets older than the TTL from the alarm, with no state change", async () => {
    const { ws } = await connect();
    await runInDurableObject(hub(), (_i, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ openedAt: 0 });
    });
    const code = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    expect(await runDurableObjectAlarm(hub())).toBe(true);
    await expect(code).resolves.toBe(4001);
  });

  it("closes a browser session's socket with 4001 when its passkey is removed", async () => {
    const { passkeyId, cookie } = await browserSession();
    const ws = await connectAuthed(cookie);
    const code = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    const res = await fetchWith(`/api/devices/passkey/${passkeyId}`, { method: "DELETE", headers: { Cookie: `__Host-cession=${cookie}` } }, authEnv);
    expect(res.status).toBe(204);
    await expect(code).resolves.toBe(4001);
  });

  it("closes a browser session's socket with 4001 after it logs out", async () => {
    const { cookie } = await browserSession();
    const ws = await connectAuthed(cookie);
    const code = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    const res = await fetchWith("/auth/logout", { method: "POST", headers: { Cookie: `__Host-cession=${cookie}` } }, authEnv);
    expect(res.status).toBe(204);
    await expect(code).resolves.toBe(4001);
  });
});
