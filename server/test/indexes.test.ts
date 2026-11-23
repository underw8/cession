import { describe, expect, it } from "vitest";
import { sql } from "./helpers";

// Each runs on every broadcast, alarm or history poll, and a full scan is billed per row read.
describe("hot queries use an index", () => {
  it.each([
    ["snapshot", `SELECT * FROM sessions WHERE status IN ('working', 'needs_you', 'idle')`],
    ["stale sweep", `SELECT 1 FROM sessions WHERE (status IN ('working', 'idle') AND last_seen < 0) OR (status = 'needs_you' AND last_seen < 0)`],
    ["retention", `SELECT 1 FROM sessions WHERE status IN ('stale', 'ended') AND last_seen < 0`],
    ["history", `SELECT 1 FROM sessions WHERE started_at >= 0 AND started_at < 1`],
    ["batch expiry", `SELECT 1 FROM otlp_batches WHERE at < 0`],
  ])("%s", async (_name, query) => {
    const plan = (await sql<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)).map((r) => r.detail).join("\n");
    expect(plan).not.toMatch(/^SCAN (sessions|otlp_batches)$/m);
  });
});
