import { describe, expect, it } from "vitest";
import { parseOtlp } from "../src/otlp";
import { liveSession, post, row, uid } from "./helpers";

type Attrs = Record<string, string>;
const attrs = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: { stringValue: v } }));

function payload(opts: {
  temporality: 1 | 2;
  cost?: { value: number; attrs: Attrs }[];
  tokens?: { value: number; attrs: Attrs }[];
  resource?: Attrs;
  // Exporters stamp every point, so two real exports never share a body.
  time?: number;
}) {
  const timeUnixNano = String((opts.time ?? 0) * 1_000_000);
  const metrics = [];
  if (opts.cost)
    metrics.push({
      name: "claude_code.cost.usage",
      sum: { aggregationTemporality: opts.temporality, isMonotonic: true,
        dataPoints: opts.cost.map((p) => ({ asDouble: p.value, timeUnixNano, attributes: attrs(p.attrs) })) },
    });
  if (opts.tokens)
    metrics.push({
      name: "claude_code.token.usage",
      sum: { aggregationTemporality: opts.temporality, isMonotonic: true,
        dataPoints: opts.tokens.map((p) => ({ asInt: String(p.value), timeUnixNano, attributes: attrs(p.attrs) })) },
    });
  metrics.push({ name: "claude_code.session.count", sum: { aggregationTemporality: opts.temporality, dataPoints: [{ asInt: "1" }] } });
  return { resourceMetrics: [{ resource: { attributes: attrs(opts.resource ?? {}) }, scopeMetrics: [{ metrics }] }] };
}

describe("parseOtlp", () => {
  it("maps cost and token types to columns, summing per session/column", () => {
    const updates = parseOtlp(payload({
      temporality: 1,
      cost: [{ value: 0.5, attrs: { "session.id": "a", model: "m1" } }, { value: 0.25, attrs: { "session.id": "a", model: "m2" } }],
      tokens: [
        { value: 100, attrs: { "session.id": "a", type: "input" } },
        { value: 7, attrs: { "session.id": "a", type: "output" } },
        { value: 30, attrs: { "session.id": "a", type: "cacheRead" } },
        { value: 4, attrs: { "session.id": "a", type: "cacheCreation" } },
        { value: 9, attrs: { "session.id": "a", type: "somethingNew" } },
      ],
    }));
    expect(updates).toEqual(expect.arrayContaining([
      { sessionId: "a", column: "cost_usd", value: 0.75, mode: "add" },
      { sessionId: "a", column: "tokens_in", value: 100, mode: "add" },
      { sessionId: "a", column: "tokens_out", value: 7, mode: "add" },
      { sessionId: "a", column: "tokens_cache_read", value: 30, mode: "add" },
      { sessionId: "a", column: "tokens_cache_write", value: 4, mode: "add" },
    ]));
    expect(updates).toHaveLength(5);
  });

  it("uses mode 'set' for cumulative temporality", () => {
    const [u] = parseOtlp(payload({ temporality: 2, cost: [{ value: 3, attrs: { "session.id": "a" } }] }));
    expect(u.mode).toBe("set");
  });

  it("falls back to session.id on the resource", () => {
    const [u] = parseOtlp(payload({ temporality: 1, resource: { "session.id": "r" }, cost: [{ value: 1, attrs: {} }] }));
    expect(u.sessionId).toBe("r");
  });

  it("skips points without a session id and tolerates garbage", () => {
    expect(parseOtlp(payload({ temporality: 1, cost: [{ value: 1, attrs: {} }] }))).toEqual([]);
    expect(parseOtlp(null)).toEqual([]);
    expect(parseOtlp({ resourceMetrics: "nope" })).toEqual([]);
  });

  it("skips points whose session id is longer than 256 characters", () => {
    const updates = parseOtlp(payload({
      temporality: 1,
      cost: [{ value: 1, attrs: { "session.id": "x".repeat(257) } }, { value: 2, attrs: { "session.id": "y".repeat(256) } }],
    }));
    expect(updates).toEqual([{ sessionId: "y".repeat(256), column: "cost_usd", value: 2, mode: "add" }]);
  });
});

describe("POST /v1/metrics", () => {
  it("requires a machine token", async () => {
    expect((await post("/v1/metrics", payload({ temporality: 1 }), "nope")).status).toBe(401);
  });

  it("delta exports add up", async () => {
    const id = uid();
    await post("/events", { session_id: id, event: "SessionStart", ts: Date.now() });
    for (let i = 0; i < 2; i++)
      expect((await post("/v1/metrics", payload({
        temporality: 1,
        time: Date.now() + i,
        cost: [{ value: 0.1, attrs: { "session.id": id } }],
        tokens: [{ value: 50, attrs: { "session.id": id, type: "input" } }],
      }))).status).toBe(200);
    const s = await liveSession(id);
    expect(s?.cost_usd).toBeCloseTo(0.2);
    expect(s?.tokens_in).toBe(100);
  });

  it("counts a retried delta export (identical body) once", async () => {
    const id = uid();
    await post("/events", { session_id: id, event: "SessionStart", ts: Date.now() });
    const body = payload({ temporality: 1, time: Date.now(), cost: [{ value: 0.3, attrs: { "session.id": id } }] });
    for (let i = 0; i < 3; i++) expect((await post("/v1/metrics", body)).status).toBe(200);
    expect((await liveSession(id))?.cost_usd).toBeCloseTo(0.3);
  });

  it("a repeated cumulative export does not double count", async () => {
    const id = uid();
    const body = payload({ temporality: 2, cost: [{ value: 1.5, attrs: { "session.id": id, model: "a" } }, { value: 0.5, attrs: { "session.id": id, model: "b" } }] });
    await post("/v1/metrics", body);
    await post("/v1/metrics", body);
    expect((await row(id))?.cost_usd).toBeCloseTo(2);
  });

  it("metrics before SessionStart create the row; a slightly older hook still sets status and metadata", async () => {
    const id = uid();
    await post("/v1/metrics", payload({ temporality: 1, cost: [{ value: 0.3, attrs: { "session.id": id } }] }));
    expect((await row(id))?.status).toBe("idle");
    // Client clock 5 s behind the server.
    await post("/events", { session_id: id, event: "UserPromptSubmit", ts: Date.now() - 5000, machine: "mbp", cwd: "/w/proj" });
    expect(await liveSession(id)).toMatchObject({ status: "working", machine: "mbp", project: "proj" });
    expect((await row(id))?.cost_usd).toBeCloseTo(0.3);
  });

  it("metrics never change status", async () => {
    const id = uid();
    await post("/events", { session_id: id, event: "UserPromptSubmit", ts: Date.now() });
    await post("/v1/metrics", payload({ temporality: 1, cost: [{ value: 0.1, attrs: { "session.id": id } }] }));
    expect((await liveSession(id))?.status).toBe("working");
  });

  it("returns 400 on invalid JSON", async () => {
    expect((await post("/v1/metrics", "{")).status).toBe(400);
  });
});
