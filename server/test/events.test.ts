import { describe, expect, it } from "vitest";
import { get, liveSession, post, row, uid } from "./helpers";

const ev = (session_id: string, event: string, ts: number, extra: object = {}) =>
  post("/events", { session_id, event, ts, ...extra });

describe("POST /events", () => {
  it("rejects a wrong token with 401 and stores nothing", async () => {
    const id = uid();
    const res = await post("/events", { session_id: id, event: "SessionStart" }, "nope");
    expect(res.status).toBe(401);
    expect(await row(id)).toBeUndefined();
  });

  it("rejects invalid JSON and missing fields with 400", async () => {
    expect((await post("/events", "{not json")).status).toBe(400);
    expect((await post("/events", { event: "Stop" })).status).toBe(400);
    expect((await post("/events", { session_id: "x" })).status).toBe(400);
  });

  it.each([
    ["session_id", 257], ["event", 257], ["machine", 257], ["branch", 257], ["cwd", 1025],
  ])("rejects an overlong %s with 400", async (field, len) => {
    const id = uid();
    const res = await post("/events", { session_id: id, event: "SessionStart", ts: Date.now(), [field]: "x".repeat(len) });
    expect(res.status).toBe(400);
    expect(await row(id)).toBeUndefined();
  });

  it("accepts fields at their length limits", async () => {
    const session_id = uid().padEnd(256, "x");
    const res = await post("/events", { session_id, event: "SessionStart", ts: Date.now(), machine: "m".repeat(256), branch: "b".repeat(256), cwd: "/".padEnd(1024, "c") });
    expect(res.status).toBe(204);
    expect((await row(session_id))?.cwd).toHaveLength(1024);
  });

  it("rejects a ts more than 5 minutes ahead or more than 24h behind with 400, and keeps a ts within range as sent", async () => {
    const id = uid();
    expect((await ev(id, "SessionStart", Date.now() + 6 * 60_000)).status).toBe(400);
    expect((await ev(id, "SessionStart", Date.now() - (24 * 60 * 60_000 + 60_000))).status).toBe(400);
    expect(await row(id)).toBeUndefined();
    const ahead = Date.now() + 60_000;
    expect((await ev(id, "SessionStart", ahead)).status).toBe(204);
    expect((await row(id))!.last_event).toBe(ahead);
  });

  it("a fast clock's late Stop does not revive an ended session", async () => {
    const id = uid();
    const t = Date.now() + 2 * 60_000;
    await ev(id, "SessionStart", t);
    await ev(id, "SessionEnd", t + 20);
    await ev(id, "Stop", t + 10);
    expect((await row(id))?.status).toBe("ended");
  });

  it("names an inherited Object property as an unknown event, not a status", async () => {
    for (const event of ["constructor", "toString", "__proto__"]) {
      const id = uid();
      expect((await ev(id, event, Date.now())).status).toBe(204);
      expect(await row(id)).toBeUndefined();
    }
  });

  it("ignores unknown events with 204", async () => {
    const id = uid();
    expect((await ev(id, "PreCompact", Date.now())).status).toBe(204);
    expect(await row(id)).toBeUndefined();
  });

  it("SessionStart creates an idle session with metadata", async () => {
    const id = uid();
    const t = Date.now() - 60_000;
    expect((await ev(id, "SessionStart", t, { machine: "mbp", cwd: "/Users/me/code/cession", branch: "main" })).status).toBe(204);
    expect(await liveSession(id)).toMatchObject({
      status: "idle", machine: "mbp", project: "cession", cwd: "/Users/me/code/cession", branch: "main",
      started_at: t, last_event: t, ended_at: null, cost_usd: 0,
    });
    // last_seen is server arrival time, not the machine's ts.
    expect((await row(id))!.last_seen).toBeGreaterThan(t);
  });

  it("walks through every status transition", async () => {
    const id = uid();
    const t = Date.now() - 60_000;
    const steps: [string, string][] = [
      ["SessionStart", "idle"], ["UserPromptSubmit", "working"], ["PermissionRequest", "needs_you"],
      ["PostToolUse", "working"], ["Notification", "needs_you"], ["Stop", "idle"],
    ];
    for (const [i, [event, status]] of steps.entries()) {
      await ev(id, event, t + i);
      expect((await liveSession(id))?.status).toBe(status);
    }
    await ev(id, "SessionEnd", t + 10);
    expect(await liveSession(id)).toBeUndefined();
    expect(await row(id)).toMatchObject({ status: "ended", ended_at: t + 10, last_event: t + 10 });
  });

  it("an older event arriving late does not override a newer status", async () => {
    const id = uid();
    const t = Date.now() - 60_000;
    await ev(id, "SessionStart", t);
    await ev(id, "Stop", t + 20);
    await ev(id, "PostToolUse", t + 10);
    expect(await liveSession(id)).toMatchObject({ status: "idle", last_event: t + 20 });
  });

  it("an event for an unseen session creates the row", async () => {
    const id = uid();
    await ev(id, "UserPromptSubmit", Date.now(), { machine: "mini", cwd: "/w/api" });
    expect(await liveSession(id)).toMatchObject({ status: "working", machine: "mini", project: "api" });
  });

  it("stores workflow progress, clears it when absent, and drops a malformed one", async () => {
    const id = uid();
    const t = Date.now() - 60_000;
    const workflow = { name: "review", phase: "Verify", done: 3, started: 5 };
    await ev(id, "PostToolUse", t, { workflow });
    expect((await liveSession(id))?.workflow).toEqual(workflow);
    // An older event arriving late doesn't roll progress back.
    await ev(id, "PostToolUse", t - 1, { workflow: { ...workflow, done: 1 } });
    expect((await liveSession(id))?.workflow).toEqual(workflow);
    await ev(id, "PostToolUse", t + 1);
    expect((await liveSession(id))?.workflow).toBeNull();
    for (const bad of [{ done: 6, started: 5 }, { done: -1, started: 5 }, { done: 1.5, started: 5 }, { name: "n".repeat(257), done: 0, started: 0 }]) {
      expect((await ev(id, "PostToolUse", t + 2, { workflow: bad })).status).toBe(204);
      expect((await liveSession(id))?.workflow).toBeNull();
    }
  });

  it("a null branch keeps the known branch; a new branch replaces it", async () => {
    const id = uid();
    const t = Date.now();
    await ev(id, "SessionStart", t, { branch: "main" });
    await ev(id, "UserPromptSubmit", t + 1, { branch: null });
    expect((await liveSession(id))?.branch).toBe("main");
    await ev(id, "Stop", t + 2, { branch: "feat/x" });
    expect((await liveSession(id))?.branch).toBe("feat/x");
  });
});

