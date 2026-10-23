import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Hub, HistoryRow } from "../src/hub";
import { get, hub, post, row, sql, uid } from "./helpers";

const DAY = 86_400_000;

// Backdates last_seen, which is server arrival time and so can't be set through an event's ts.
const silence = (id: string, ms: number) => sql("UPDATE sessions SET last_seen = ? WHERE id = ?", Date.now() - ms, id);

const cost = (id: string, value: number, temporality = 2) => ({
  resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage",
    sum: { aggregationTemporality: temporality, dataPoints: [{ asDouble: value, attributes: [{ key: "session.id", value: { stringValue: id } }] }] } }] }] }],
});

// Feeds fixtures straight to the Hub: this file seeds history far outside the 24h ingest window,
// which parseEvent (tested in events.test.ts) would otherwise reject.
const ev = (session_id: string, event: string, ts: number, extra: Partial<{ machine: string; cwd: string; branch: string }> = {}) =>
  runInDurableObject(hub(), (inst: Hub) =>
    inst.applyEvent({ session_id, event, ts, machine: extra.machine ?? null, cwd: extra.cwd ?? null, branch: extra.branch ?? null, workflow: null }));

describe("stale sweep", () => {
  it("marks sessions silent for 30+ minutes stale, keeps fresh ones, and revives on a new event", async () => {
    const old = uid("old");
    const fresh = uid("fresh");
    await ev(old, "UserPromptSubmit", Date.now() - 31 * 60_000);
    await ev(fresh, "SessionStart", Date.now());
    await silence(old, 31 * 60_000);

    expect(await runDurableObjectAlarm(hub())).toBe(true);
    expect((await row(old))?.status).toBe("stale");
    expect((await row(fresh))?.status).toBe("idle");

    await ev(old, "UserPromptSubmit", Date.now());
    expect((await row(old))?.status).toBe("working");
  });

  it("keeps a needs_you session for 24 hours of silence, then marks it stale", async () => {
    const id = uid();
    await ev(id, "PermissionRequest", Date.now());
    await silence(id, 2 * 60 * 60_000);
    await runDurableObjectAlarm(hub());
    expect((await row(id))?.status).toBe("needs_you");
    await silence(id, 25 * 60 * 60_000);
    await ev(uid(), "SessionStart", Date.now()); // guarantees an alarm is scheduled
    await runDurableObjectAlarm(hub());
    expect((await row(id))?.status).toBe("stale");
  });

  it("prunes finished sessions and daily usage older than a year", async () => {
    const id = uid();
    await ev(id, "SessionStart", Date.now());
    await ev(id, "SessionEnd", Date.now());
    await post("/v1/metrics", cost(id, 1));
    await silence(id, 366 * DAY);
    await sql("UPDATE usage_daily SET day = ? WHERE session_id = ?", Date.now() - 366 * DAY, id);
    await ev(uid(), "SessionStart", Date.now());
    await runDurableObjectAlarm(hub());
    expect(await row(id)).toBeUndefined();
    expect(await sql("SELECT 1 FROM usage_daily WHERE session_id = ?", id)).toHaveLength(0);
  });

  it("does not touch ended sessions", async () => {
    const id = uid();
    const t = Date.now() - 60 * 60_000;
    await ev(id, "SessionStart", t);
    await ev(id, "SessionEnd", t + 1);
    await ev(uid(), "SessionStart", Date.now()); // guarantees an alarm is scheduled
    await runDurableObjectAlarm(hub());
    expect((await row(id))?.status).toBe("ended");
  });
});

describe("GET /api/history", () => {
  // Far from other tests' timestamps; fed through applyEvent directly, so the ingest age limit doesn't apply.
  const T = Date.UTC(2021, 0, 1);

  // Each test seeds its own base time so exact counts never see another test's rows.
  async function seed(base: number) {
    const p = uid("proj");
    const a = uid(), b = uid(), c = uid();
    await ev(a, "SessionStart", base, { cwd: `/w/${p}` });
    await ev(a, "SessionEnd", base + 60_000);
    await ev(b, "SessionStart", base + 1000, { cwd: `/w/${p}` });
    await ev(b, "Stop", base + 1000 + 120_000);
    await ev(c, "SessionStart", base + DAY, { cwd: `/w/${p}-other` });
    await ev(c, "Stop", base + DAY + 30_000);
    return p;
  }

  it("groups duration by UTC day", async () => {
    await seed(T);
    const rows = (await (await get(`/api/history?by=day&from=${T}&to=${T + 2 * DAY}`)).json()) as HistoryRow[];
    const d1 = rows.find((r) => r.key === "2021-01-01");
    const d2 = rows.find((r) => r.key === "2021-01-02");
    expect(d1).toMatchObject({ sessions: 2, duration_ms: 60_000 + 120_000 });
    expect(d2).toMatchObject({ sessions: 1, duration_ms: 30_000 });
  });

  it("groups by project", async () => {
    const base = T + 10 * DAY;
    const p = await seed(base);
    const rows = (await (await get(`/api/history?by=project&from=${base}&to=${base + 2 * DAY}`)).json()) as HistoryRow[];
    expect(rows.find((r) => r.key === p)).toMatchObject({ sessions: 2, duration_ms: 180_000 });
    expect(rows.find((r) => r.key === `${p}-other`)).toMatchObject({ sessions: 1 });
  });

  it("counts cost on the UTC day it accrued, not the day the session started", async () => {
    const id = uid();
    const p = uid("proj");
    const start = Date.now() - 2 * DAY;
    await ev(id, "SessionStart", start, { cwd: `/w/${p}` });
    await post("/v1/metrics", cost(id, 3));
    const booked = await sql<{ day: number; cost_usd: number }>("SELECT day, cost_usd FROM usage_daily WHERE session_id = ?", id);
    expect(booked).toHaveLength(1);
    const { day } = booked[0];
    expect(booked[0].cost_usd).toBe(3);
    expect(day).toBeGreaterThan(start);
    const history = async (from: number, to: number) =>
      ((await (await get(`/api/history?by=project&from=${from}&to=${to}`)).json()) as HistoryRow[]).find((r) => r.key === p);
    expect(await history(day, day + DAY)).toMatchObject({ sessions: 0, cost_usd: 3 });
    expect(await history(start, day)).toMatchObject({ sessions: 1, cost_usd: 0 });
  });

  it("keeps the larger cumulative total when an older export arrives late", async () => {
    const id = uid();
    await ev(id, "SessionStart", Date.now());
    await post("/v1/metrics", cost(id, 5));
    await post("/v1/metrics", cost(id, 2));
    expect((await row(id))?.cost_usd).toBe(5);
    await post("/v1/metrics", cost(id, 1, 1));
    expect((await row(id))?.cost_usd).toBe(6);
  });

  it("rejects a bad grouping or non-numeric range with 400", async () => {
    expect((await get("/api/history?by=week")).status).toBe(400);
    expect((await get("/api/history?from=abc")).status).toBe(400);
  });

  it("defaults to the last 7 days by day", async () => {
    const res = await get("/api/history");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
