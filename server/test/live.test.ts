import { describe, expect, it, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Snapshot } from "../src/hub";
import { assertion, authEnv, fetchWith, get, hub, owner, post, uid } from "./helpers";

/** Opens /live; with a cookie it authenticates like a browser session, otherwise like the dev bypass. */
async function connect(cookie?: string) {
  const res = cookie
    ? await fetchWith("/live", { headers: { Upgrade: "websocket", Cookie: `__Host-cession=${cookie}` } }, authEnv)
    : await get("/live", { headers: { Upgrade: "websocket" } });
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
    const { auth, id, cookie } = await owner();
    const { ws } = await connect(cookie);
    const code = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    const body = JSON.stringify({ assertion: await assertion(auth) });
    const res = await fetchWith(`/api/devices/passkey/${id}`, { method: "DELETE", headers: { Cookie: `__Host-cession=${cookie}` }, body }, authEnv);
    expect(res.status).toBe(204);
    await expect(code).resolves.toBe(4001);
  });

  it("closes a browser session's socket with 4001 after it logs out", async () => {
    const { cookie } = await owner();
    const { ws } = await connect(cookie);
    const code = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    const res = await fetchWith("/auth/logout", { method: "POST", headers: { Cookie: `__Host-cession=${cookie}` } }, authEnv);
    expect(res.status).toBe(204);
    await expect(code).resolves.toBe(4001);
  });
});
