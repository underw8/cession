export interface HookEvent {
  session_id: string;
  event: string;
  machine: string | null;
  cwd: string | null;
  branch: string | null;
  ts: number;
}

const MAX_FIELD = 256;
const MAX_CWD = 1024;
// Ordering uses the machine's own ts, so a clock ahead by more than this could pin status
// (last_event) until real time catches up; such events are rejected.
const MAX_SKEW_MS = 5 * 60_000;
// Hooks report live, so an event older than this is replay/forgery, not a slow upload.
const MAX_AGE_MS = 24 * 60 * 60_000;

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const tooLong = (v: string | null, max: number) => v !== null && v.length > max;

export function parseEvent(body: unknown, now = Date.now()): HookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const e = {
    session_id: str(b.session_id),
    event: str(b.event),
    machine: str(b.machine),
    cwd: str(b.cwd),
    branch: str(b.branch),
    ts: typeof b.ts === "number" && Number.isFinite(b.ts) ? b.ts : now,
  };
  if (!e.session_id || !e.event) return null;
  if ([e.session_id, e.event, e.machine, e.branch].some((v) => tooLong(v, MAX_FIELD)) || tooLong(e.cwd, MAX_CWD)) return null;
  // Rejected rather than clamped: clamping would erase the order of a fast clock's events.
  if (e.ts < now - MAX_AGE_MS || e.ts > now + MAX_SKEW_MS) return null;
  return e as HookEvent;
}
