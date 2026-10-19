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
// A monotonic counter export should never reach this; it only bounds the damage from a malformed one.
export const MAX_USAGE = 1e12;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const attr = (attrs: Attr[] | undefined, key: string): string | undefined => {
  const v = list<Attr>(attrs).find((a) => a.key === key)?.value?.stringValue;
  return typeof v === "string" ? v : undefined;
};

const COST_METRIC = "claude_code.cost.usage";
const TOKEN_METRIC = "claude_code.token.usage";

function columnFor(m: Metric, p: Point): UsageColumn | undefined {
  if (m.name === COST_METRIC) return "cost_usd";
  const type = attr(p.attributes, "type") ?? "";
  return Object.hasOwn(TOKEN_COLUMN, type) ? TOKEN_COLUMN[type] : undefined;
}

/** The update one data point carries, or null when it isn't a usable Claude Code point. */
function pointUpdate(m: Metric, p: Point, resourceSession: string | undefined): UsageUpdate | null {
  const sessionId = attr(p.attributes, "session.id") ?? resourceSession;
  const column = columnFor(m, p);
  const value = Number(p.asDouble ?? p.asInt ?? 0);
  // Counters never go down, so a negative value is junk.
  if (!sessionId || sessionId.length > MAX_ID || !column || !Number.isFinite(value) || value < 0) return null;
  return { sessionId, column, value, mode: m.sum?.aggregationTemporality === 2 ? "set" : "add" };
}

/** Sums Claude Code cost/token points per session and column. Cumulative (2) → "set", otherwise "add". */
export function parseOtlp(body: unknown): UsageUpdate[] {
  const points = list<{ resource?: { attributes?: Attr[] }; scopeMetrics?: unknown }>((body as any)?.resourceMetrics).flatMap((rm) => {
    const resourceSession = attr(rm?.resource?.attributes, "session.id");
    return list<{ metrics?: unknown }>(rm?.scopeMetrics)
      .flatMap((sm) => list<Metric>(sm?.metrics))
      .filter((m) => m?.name === COST_METRIC || m?.name === TOKEN_METRIC)
      .flatMap((m) => list<Point>(m.sum?.dataPoints).map((p) => pointUpdate(m, p, resourceSession)));
  });
  const totals = new Map<string, UsageUpdate>();
  for (const u of points) {
    if (!u) continue;
    const key = `${u.sessionId}\n${u.column}`;
    const seen = totals.get(key);
    if (seen) seen.value += u.value;
    else totals.set(key, u);
  }
  return [...totals.values()].filter((u) => u.value <= MAX_USAGE);
}
