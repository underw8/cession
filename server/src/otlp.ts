export const USAGE_COLUMNS = ["cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"] as const;
export type UsageColumn = (typeof USAGE_COLUMNS)[number];

export interface UsageUpdate {
  sessionId: string;
  column: UsageColumn;
  value: number;
  mode: "add" | "set";
}

const TOKEN_COLUMN: Record<string, UsageColumn> = {
  input: "tokens_in",
  output: "tokens_out",
  cacheRead: "tokens_cache_read",
  cacheCreation: "tokens_cache_write",
};

type Attr = { key?: string; value?: { stringValue?: string } };
type Point = { attributes?: Attr[]; asDouble?: number; asInt?: string | number };
type Metric = { name?: string; sum?: { aggregationTemporality?: number; dataPoints?: Point[] } };

const MAX_ID = 256;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const attr = (attrs: Attr[] | undefined, key: string) => list<Attr>(attrs).find((a) => a.key === key)?.value?.stringValue;

/** Sums Claude Code cost/token points per session and column. Cumulative (2) → "set", otherwise "add". */
export function parseOtlp(body: unknown): UsageUpdate[] {
  const totals = new Map<string, UsageUpdate>();
  for (const rm of list<{ resource?: { attributes?: Attr[] }; scopeMetrics?: unknown }>((body as any)?.resourceMetrics)) {
    const resourceSession = attr(rm?.resource?.attributes, "session.id");
    for (const sm of list<{ metrics?: unknown }>(rm?.scopeMetrics)) {
      for (const m of list<Metric>(sm?.metrics)) {
        const isCost = m?.name === "claude_code.cost.usage";
        if (!isCost && m?.name !== "claude_code.token.usage") continue;
        const mode = m.sum?.aggregationTemporality === 2 ? "set" : "add";
        for (const p of list<Point>(m.sum?.dataPoints)) {
          const sessionId = attr(p.attributes, "session.id") ?? resourceSession;
          const column = isCost ? "cost_usd" : TOKEN_COLUMN[attr(p.attributes, "type") ?? ""];
          const value = Number(p.asDouble ?? p.asInt ?? 0);
          if (!sessionId || sessionId.length > MAX_ID || !column || !Number.isFinite(value) || value < 0) continue; // counters never go down
          const key = `${sessionId}\n${column}`;
          const u = totals.get(key) ?? { sessionId, column, value: 0, mode };
          u.value += value;
          totals.set(key, u);
        }
      }
    }
  }
  return [...totals.values()];
}
