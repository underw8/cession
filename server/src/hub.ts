import { DurableObject } from "cloudflare:workers";
import * as authstore from "./authstore";
import { digest, type Attempt, type ChallengePurpose, type DeviceKind, type DeviceRequest, type Devices, type FailureKey, type PasskeyRow, type Session, type SessionKind } from "./authstore";
import type { HookEvent } from "./event";
import { USAGE_COLUMNS, type UsageColumn, type UsageUpdate } from "./otlp";

export type Status = "working" | "needs_you" | "idle" | "stale" | "ended";

const STALE_MS = 30 * 60_000;
// A permission prompt waits for the user, so it outlives the normal sweep; a crashed session still clears.
const NEEDS_YOU_STALE_MS = 24 * 60 * 60_000;
const DAY_MS = 86_400_000;
// ponytail: fixed retention for finished sessions and daily usage; make it a var if anyone needs more history.
const RETAIN_MS = 365 * DAY_MS;
const SWEEP_MS = 5 * 60_000;
const SOCKET_TTL_MS = 12 * 60 * 60_000; // clients must re-auth at least this often
const LIVE_SQL = `('working', 'needs_you', 'idle')`;

// Per-socket state that survives hibernation; sessionId lets revoke find the socket.
type Attachment = { openedAt: number; sessionId?: string | null };

export type HistoryRow = { key: string; sessions: number; duration_ms: number } & Record<UsageColumn, number>;

export type SessionRow = {
  id: string;
  machine: string | null;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  status: Status;
  started_at: number | null;
  last_seen: number;
  last_event: number;
  ended_at: number | null;
} & Record<UsageColumn, number>;

export interface Snapshot {
  sessions: SessionRow[];
}

const STATUS_FOR_EVENT: Record<string, Status> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PostToolUse: "working",
  PermissionRequest: "needs_you",
  Notification: "needs_you",
  Stop: "idle",
  SessionEnd: "ended",
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  machine            TEXT,
  project            TEXT,
  cwd                TEXT,
  branch             TEXT,
  status             TEXT NOT NULL,
  started_at         INTEGER,
  last_seen          INTEGER NOT NULL,
  last_event         INTEGER NOT NULL DEFAULT 0,
  ended_at           INTEGER,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0
)`;

// Usage accrued per UTC day, so history counts spend on the day it happened, not the day a session started.
const USAGE_SCHEMA = `CREATE TABLE usage_daily (
  day                INTEGER NOT NULL,
  session_id         TEXT    NOT NULL,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
)`;

// Usage from before usage_daily existed lands on each session's start day.
const BACKFILL_USAGE = `INSERT INTO usage_daily
  SELECT started_at - started_at % ${DAY_MS}, id, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
  FROM sessions WHERE started_at IS NOT NULL`;

// Hooks post in the background, so events can arrive out of order:
// only an event at least as new as last_event may change status/ended_at.
const UPSERT_EVENT = `
INSERT INTO sessions (id, machine, project, cwd, branch, status, started_at, last_seen, last_event, ended_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  machine    = COALESCE(excluded.machine, sessions.machine),
  project    = COALESCE(excluded.project, sessions.project),
  cwd        = COALESCE(excluded.cwd, sessions.cwd),
  branch     = COALESCE(excluded.branch, sessions.branch),
  started_at = MIN(COALESCE(sessions.started_at, excluded.started_at), excluded.started_at),
  status     = CASE WHEN excluded.last_event >= sessions.last_event THEN excluded.status   ELSE sessions.status   END,
  ended_at   = CASE WHEN excluded.last_event >= sessions.last_event THEN excluded.ended_at ELSE sessions.ended_at END,
  last_event = MAX(sessions.last_event, excluded.last_event),
  last_seen  = MAX(sessions.last_seen, excluded.last_seen)`;

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.sql.exec(authstore.AUTH_SCHEMA);
    authstore.migrateAuth(this.sql);
    // One transaction, so the table never exists without its backfill.
    if (!this.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'usage_daily'`).toArray().length) {
      ctx.storage.transactionSync(() => {
        this.sql.exec(USAGE_SCHEMA);
        this.sql.exec(BACKFILL_USAGE);
      });
    }
  }

  async createMachineToken(name: string, passkeyId: string | null = null): Promise<{ id: string; token: string }> {
    return authstore.createMachineToken(this.sql, name, passkeyId);
  }

  async checkMachineToken(token: string): Promise<boolean> {
    return authstore.checkMachineToken(this.sql, token);
  }

  async createSession(kind: SessionKind, label: string, passkeyId: string | null = null): Promise<string> {
    return authstore.createSession(this.sql, kind, label, passkeyId);
  }

  async getSession(raw: string): Promise<Session | null> {
    return authstore.getSession(this.sql, raw);
  }

  async createPairingCode(passkeyId: string | null = null): Promise<{ code: string; expires_at: number }> {
    return authstore.createPairingCode(this.sql, passkeyId);
  }

  async redeemPairingCode(input: string, label: string, ...ips: string[]): Promise<{ status: "ok"; raw: string } | { status: Exclude<Attempt, "ok"> }> {
    return authstore.redeemPairingCode(this.sql, input, label, ...ips);
  }

  async createDeviceCode(name: string, ip: string): Promise<{ device_code: string; user_code: string }> {
    return authstore.createDeviceCode(this.sql, name, ip);
  }

  lookupDeviceCode(userCode: string): DeviceRequest | null {
    return authstore.lookupDeviceCode(this.sql, userCode);
  }

  approveDeviceCode(userCode: string, passkeyId: string | null): boolean {
    return authstore.approveDeviceCode(this.sql, userCode, passkeyId);
  }

  async pollDeviceCode(deviceCode: string): Promise<{ token: string } | "pending" | "expired"> {
    return authstore.pollDeviceCode(this.sql, deviceCode);
  }

  putChallenge(challenge: string, purpose: ChallengePurpose): void {
    authstore.putChallenge(this.sql, challenge, purpose);
  }

  takeChallenge(challenge: string, purpose: ChallengePurpose): boolean {
    return authstore.takeChallenge(this.sql, challenge, purpose);
  }

  addPasskey(p: { id: string; public_key: string; counter: number; transports: string | null; name: string }): void {
    authstore.addPasskey(this.sql, p);
  }

  getPasskey(id: string): PasskeyRow | null {
    return authstore.getPasskey(this.sql, id);
  }

  bumpPasskey(id: string, counter: number): void {
    authstore.bumpPasskey(this.sql, id, counter);
  }

  /**
   * Hashes first, then lock check, compare and failure record with no await between.
   * Comparing fixed-length digests means the timing reveals neither content nor length.
   */
  async trySetupCode(got: string, want: string, ...ips: string[]): Promise<Attempt> {
    const [a, b] = await Promise.all([digest(got), digest(want)]);
    const attempt = authstore.claimAttempt(this.sql, ...ips.map((ip) => `setup:${ip}` as const));
    if (attempt === null) return "locked";
    if (!crypto.subtle.timingSafeEqual(a, b)) return "bad";
    authstore.clearAttempt(this.sql, attempt);
    return "ok";
  }

  /** Counts an attempt as failed up front against every key; the caller clears it on success. Null when locked. */
  claimAttempt(...keys: FailureKey[]): number[] | null {
    return authstore.claimAttempt(this.sql, ...keys);
  }

  clearAttempt(ids: number[]): void {
    authstore.clearAttempt(this.sql, ids);
  }

  locked(key: FailureKey): boolean {
    return authstore.locked(this.sql, key);
  }

  devices(currentSessionId: string | null): Devices {
    return authstore.devices(this.sql, currentSessionId);
  }

  revoke(kind: DeviceKind, id: string): boolean {
    const ended = authstore.revoke(this.sql, kind, id);
    if (!ended) return false;
    for (const ws of this.ctx.getWebSockets()) {
      const sessionId = (ws.deserializeAttachment() as Attachment | null)?.sessionId;
      if (!sessionId || !ended.includes(sessionId)) continue;
      try {
        ws.close(4001, "revoked");
      } catch {
        // Already closing.
      }
    }
    return true;
  }

  async applyEvent(e: HookEvent): Promise<void> {
    if (!Object.hasOwn(STATUS_FOR_EVENT, e.event)) return;
    const status = STATUS_FOR_EVENT[e.event];
    const project = e.cwd?.split("/").filter(Boolean).pop() ?? null;
    const endedAt = status === "ended" ? e.ts : null;
    // last_seen is arrival time, since the stale sweep compares it with the server clock.
    this.sql.exec(UPSERT_EVENT, e.session_id, e.machine, project, e.cwd, e.branch, status, e.ts, Date.now(), e.ts, endedAt);
    this.broadcast();
    if (status !== "ended") await this.ensureAlarm();
  }

  async applyUsage(updates: UsageUpdate[]): Promise<void> {
    const now = Date.now();
    for (const u of updates) {
      if (!USAGE_COLUMNS.includes(u.column)) continue;
      // last_event stays 0 on insert so any later hook event, even with a lagging clock, sets status.
      this.sql.exec(
        `INSERT INTO sessions (id, status, started_at, last_seen) VALUES (?, 'idle', ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = MAX(sessions.last_seen, excluded.last_seen)`,
        u.sessionId, now, now,
      );
      // Cumulative totals only grow, so a late older export can't roll them back.
      // ponytail: a session pruned after a year that exports again books its whole total today; add tombstones if that ever happens.
      const before = this.sql.exec<{ v: number }>(`SELECT ${u.column} AS v FROM sessions WHERE id = ?`, u.sessionId).one().v;
      const after = u.mode === "add" ? before + u.value : Math.max(before, u.value);
      if (after === before) continue;
      this.sql.exec(`UPDATE sessions SET ${u.column} = ? WHERE id = ?`, after, u.sessionId);
      this.sql.exec(
        `INSERT INTO usage_daily (day, session_id, ${u.column}) VALUES (?, ?, ?)
         ON CONFLICT(day, session_id) DO UPDATE SET ${u.column} = usage_daily.${u.column} + excluded.${u.column}`,
        now - (now % DAY_MS), u.sessionId, after - before,
      );
    }
    if (updates.length) {
      this.broadcast();
      await this.ensureAlarm();
    }
  }

  snapshot(): Snapshot {
    const sessions = this.sql
      .exec<SessionRow>(`SELECT * FROM sessions WHERE status IN ${LIVE_SQL}`)
      .toArray();
    return { sessions };
  }

  async fetch(req: Request): Promise<Response> {
    const sessionId = req.headers.get("X-Cession-Session");
    // Re-check here: a revoke between the worker's gate and this accept would otherwise leave a socket open.
    const live =
      sessionId === "dev" ||
      this.sql.exec(`SELECT 1 FROM auth_sessions WHERE id = ? AND expires_at >= ?`, sessionId, Date.now()).toArray().length > 0;
    if (!live) return new Response("unauthorized", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ openedAt: Date.now(), sessionId } satisfies Attachment);
    server.send(JSON.stringify(this.snapshot()));
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Closes sockets past their TTL and returns the rest. */
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      try {
        const { openedAt } = (ws.deserializeAttachment() ?? { openedAt: 0 }) as Attachment;
        if (Date.now() - openedAt <= SOCKET_TTL_MS) return true;
        ws.close(4001, "reauthenticate");
      } catch {
        // Socket already closing; the runtime drops it.
      }
      return false;
    });
  }

  private broadcast(): void {
    const sockets = this.sockets();
    if (!sockets.length) return;
    const message = JSON.stringify(this.snapshot());
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Socket already closing; the runtime drops it.
      }
    }
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const { rowsWritten } = this.sql.exec(
      `UPDATE sessions SET status = 'stale'
       WHERE (status IN ('working', 'idle') AND last_seen < ?) OR (status = 'needs_you' AND last_seen < ?)`,
      now - STALE_MS, now - NEEDS_YOU_STALE_MS,
    );
    this.sql.exec(`DELETE FROM sessions WHERE status IN ('stale', 'ended') AND last_seen < ?`, now - RETAIN_MS);
    this.sql.exec(`DELETE FROM usage_daily WHERE day < ?`, now - RETAIN_MS);
    if (rowsWritten) this.broadcast();
    // Also runs while only sockets remain, so the socket TTL holds without any state change.
    const sockets = this.sockets();
    const live = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE status IN ${LIVE_SQL}`).one().n;
    if (live || sockets.length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  // ponytail: days are UTC; pass a tz offset if local-day grouping matters.
  /**
   * Sessions and duration count by start time; cost and tokens by the day they accrued. The range
   * widens to whole UTC days, since usage is only known per day.
   */
  history(from: number, to: number, by: "day" | "project"): HistoryRow[] {
    from -= from % DAY_MS;
    to += (DAY_MS - (to % DAY_MS)) % DAY_MS;
    const day = by === "day";
    const sessionKey = day ? `date(started_at / 1000, 'unixepoch')` : `COALESCE(project, '(unknown)')`;
    const usageKey = day ? `date(u.day / 1000, 'unixepoch')` : `COALESCE(s.project, '(unknown)')`;
    const cols = USAGE_COLUMNS;
    return this.sql
      .exec<HistoryRow>(
        `SELECT key, SUM(n) AS sessions, SUM(d) AS duration_ms, ${cols.map((c) => `SUM(${c}) AS ${c}`).join(", ")}
         FROM (
           SELECT ${sessionKey} AS key, 1 AS n, MAX(COALESCE(ended_at, last_event) - started_at, 0) AS d,
                  ${cols.map((c) => `0 AS ${c}`).join(", ")}
           FROM sessions WHERE started_at >= ? AND started_at < ?
           UNION ALL
           SELECT ${usageKey}, 0, 0, ${cols.map((c) => `u.${c}`).join(", ")}
           FROM usage_daily u LEFT JOIN sessions s ON s.id = u.session_id
           WHERE u.day >= ? AND u.day < ?
         )
         GROUP BY key
         ORDER BY key`,
        from, to, from, to,
      )
      .toArray();
  }
}
