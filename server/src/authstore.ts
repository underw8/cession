import { isoBase64URL } from "@simplewebauthn/server/helpers";

export type SessionKind = "browser" | "widget";
// passkey_id is the passkey this session, token or code descends from; removing it removes them.
export type Session = { id: string; kind: SessionKind; passkey_id: string | null };
export type DeviceKind = "machine" | "widget" | "browser" | "passkey";
export type ChallengePurpose = "register" | "login";
// Keys are "<kind>:<ip>", counted for the caller's /64 (or IPv4) and /48.
export type FailureKey = `${"setup" | "pair" | "login_opts" | "device"}:${string}`;

export type PasskeyRow = {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
};

export type Devices = {
  machines: { id: string; name: string; created_at: number; last_used: number | null }[];
  widgets: { id: string; label: string; created_at: number; last_used: number }[];
  browsers: { id: string; label: string; created_at: number; last_used: number; current: boolean }[];
  passkeys: { id: string; name: string; created_at: number }[];
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_EXTEND_AFTER_MS = 24 * 60 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
export const DEVICE_TTL_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const LOCK_WINDOW_MS = 10 * 60_000;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_LENGTH = 8;

// No global ceilings, so strangers can only lock their own prefixes: setup codes are at least
// 32 characters and pairing codes single-use, 31^8 and live 10 minutes, so guessing stays hopeless.
function limitFor(key: FailureKey): number {
  if (key.endsWith("::/48")) return 100;
  if (key.startsWith("login_opts:")) return 30;
  return 10;
}

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_tokens (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used  INTEGER,
  passkey_id TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  passkey_id TEXT
);
CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter    INTEGER NOT NULL,
  transports TEXT,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  challenge  TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  hash       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  passkey_id TEXT
);
CREATE TABLE IF NOT EXISTS device_codes (
  hash       TEXT PRIMARY KEY,
  user_code  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  ip         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved   INTEGER NOT NULL DEFAULT 0,
  passkey_id TEXT
);
CREATE TABLE IF NOT EXISTS auth_failures (
  kind TEXT NOT NULL,
  at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_kind_at ON auth_failures (kind, at);
CREATE INDEX IF NOT EXISTS auth_failures_at ON auth_failures (at);
CREATE INDEX IF NOT EXISTS challenges_expires_at ON challenges (expires_at);
`;

export function randomToken(prefix: string): string {
  return `${prefix}${isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export const digest = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

export async function sha256hex(s: string): Promise<string> {
  return [...new Uint8Array(await digest(s))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_LENGTH));
  return [...bytes].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}

export const normalizeCode = (input: string) => input.toUpperCase().replaceAll(/[\s-]/g, "");

export async function createMachineToken(sql: SqlStorage, name: string, passkeyId: string | null): Promise<{ id: string; token: string }> {
  const token = randomToken("cs_");
  const id = crypto.randomUUID();
  const hash = await sha256hex(token);
  sql.exec(
    `INSERT INTO machine_tokens (id, name, hash, created_at, last_used, passkey_id) VALUES (?, ?, ?, ?, NULL, ?)`,
    id, name, hash, Date.now(), passkeyId,
  );
  return { id, token };
}

export async function checkMachineToken(sql: SqlStorage, token: string): Promise<boolean> {
  const hash = await sha256hex(token);
  return sql.exec(`UPDATE machine_tokens SET last_used = ? WHERE hash = ?`, Date.now(), hash).rowsWritten > 0;
}

/** Adds columns introduced after a table was first created; CREATE TABLE IF NOT EXISTS skips them. */
export function migrateAuth(sql: SqlStorage): void {
  const added = (table: string) => {
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN passkey_id TEXT`);
      return true;
    } catch {
      return false; // Column already exists.
    }
  };
  // Older browser sessions can't be traced to a passkey, so sign them out once.
  if (added("auth_sessions")) sql.exec(`DELETE FROM auth_sessions WHERE kind = 'browser'`);
  added("machine_tokens");
  added("pairing_codes");
}

export async function createSession(sql: SqlStorage, kind: SessionKind, label: string, passkeyId: string | null): Promise<string> {
  const raw = randomToken("");
  const id = crypto.randomUUID();
  const hash = await sha256hex(raw);
  const now = Date.now();
  sql.exec(`DELETE FROM auth_sessions WHERE expires_at < ?`, now);
  sql.exec(
    `INSERT INTO auth_sessions (id, kind, hash, label, created_at, last_used, expires_at, passkey_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, kind, hash, label, now, now, now + SESSION_TTL_MS, passkeyId,
  );
  return raw;
}

export async function getSession(sql: SqlStorage, raw: string): Promise<Session | null> {
  const hash = await sha256hex(raw);
  const row = sql
    .exec<Session & { last_used: number; expires_at: number }>(
      `SELECT id, kind, passkey_id, last_used, expires_at FROM auth_sessions WHERE hash = ?`,
      hash,
    )
    .toArray()[0];
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) return null;
  if (now - row.last_used > SESSION_EXTEND_AFTER_MS) {
    sql.exec(`UPDATE auth_sessions SET last_used = ?, expires_at = ? WHERE id = ?`, now, now + SESSION_TTL_MS, row.id);
  }
  return { id: row.id, kind: row.kind, passkey_id: row.passkey_id };
}

export async function createPairingCode(sql: SqlStorage, passkeyId: string | null): Promise<{ code: string; expires_at: number }> {
  const code = pairingCode();
  const expires_at = Date.now() + PAIRING_TTL_MS;
  const hash = await sha256hex(code);
  sql.exec(`INSERT INTO pairing_codes (hash, expires_at, passkey_id) VALUES (?, ?, ?)`, hash, expires_at, passkeyId);
  return { code, expires_at };
}

export type Attempt = "ok" | "locked" | "bad";

export async function redeemPairingCode(
  sql: SqlStorage,
  input: string,
  label: string,
  ...ips: string[]
): Promise<{ status: "ok"; raw: string } | { status: Exclude<Attempt, "ok"> }> {
  const attempt = claimAttempt(sql, ...ips.map((ip) => `pair:${ip}` as const));
  if (attempt === null) return { status: "locked" };
  const hash = await sha256hex(normalizeCode(input));
  const now = Date.now();
  sql.exec(`DELETE FROM pairing_codes WHERE expires_at < ?`, now);
  const code = sql.exec<{ passkey_id: string | null }>(`DELETE FROM pairing_codes WHERE hash = ? RETURNING passkey_id`, hash).toArray()[0]; // single use
  if (!code) return { status: "bad" };
  clearAttempt(sql, attempt);
  return { status: "ok", raw: await createSession(sql, "widget", label, code.passkey_id) };
}

export type DeviceRequest = { name: string; ip: string; created_at: number };

/** Starts a device login (RFC 8628): a secret device code for the machine, a short user code for the browser. */
export async function createDeviceCode(sql: SqlStorage, name: string, ip: string): Promise<{ device_code: string; user_code: string }> {
  const device_code = randomToken("");
  const user_code = pairingCode();
  const now = Date.now();
  sql.exec(`DELETE FROM device_codes WHERE expires_at < ?`, now);
  sql.exec(
    `INSERT INTO device_codes (hash, user_code, name, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    await sha256hex(device_code), user_code, name, ip, now, now + DEVICE_TTL_MS,
  );
  return { device_code, user_code };
}

/** The pending, unexpired request behind a user code, for the browser to confirm. */
export function lookupDeviceCode(sql: SqlStorage, input: string): DeviceRequest | null {
  return sql
    .exec<DeviceRequest>(`SELECT name, ip, created_at FROM device_codes WHERE user_code = ? AND approved = 0 AND expires_at >= ?`, normalizeCode(input), Date.now())
    .toArray()[0] ?? null;
}

export function approveDeviceCode(sql: SqlStorage, input: string, passkeyId: string | null): boolean {
  return sql.exec(
    `UPDATE device_codes SET approved = 1, passkey_id = ? WHERE user_code = ? AND approved = 0 AND expires_at >= ?`,
    passkeyId, normalizeCode(input), Date.now(),
  ).rowsWritten > 0;
}

/** The machine's poll: a token once approved (single use), else whether to keep waiting. */
export async function pollDeviceCode(sql: SqlStorage, deviceCode: string): Promise<{ token: string } | "pending" | "expired"> {
  const hash = await sha256hex(deviceCode);
  const row = sql
    .exec<{ name: string; approved: number; expires_at: number; passkey_id: string | null }>(
      `SELECT name, approved, expires_at, passkey_id FROM device_codes WHERE hash = ?`, hash,
    )
    .toArray()[0];
  if (!row || row.expires_at < Date.now()) return "expired";
  if (!row.approved) return "pending";
  // Deleted before the await, so a racing poll can't mint a second token.
  sql.exec(`DELETE FROM device_codes WHERE hash = ?`, hash);
  return { token: (await createMachineToken(sql, row.name, row.passkey_id)).token };
}

export function putChallenge(sql: SqlStorage, challenge: string, purpose: ChallengePurpose): void {
  const now = Date.now();
  sql.exec(`DELETE FROM challenges WHERE expires_at < ?`, now);
  sql.exec(`INSERT INTO challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)`, challenge, purpose, now + CHALLENGE_TTL_MS);
}

export function takeChallenge(sql: SqlStorage, challenge: string, purpose: ChallengePurpose): boolean {
  const now = Date.now();
  sql.exec(`DELETE FROM challenges WHERE expires_at < ?`, now);
  // Expired rows are gone by now, so any row left is live; deleting it makes it single use.
  const row = sql.exec<{ purpose: string }>(`DELETE FROM challenges WHERE challenge = ? RETURNING purpose`, challenge).toArray()[0];
  return row?.purpose === purpose;
}

export function addPasskey(sql: SqlStorage, p: { id: string; public_key: string; counter: number; transports: string | null; name: string }): void {
  sql.exec(
    `INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    p.id, p.public_key, p.counter, p.transports, p.name, Date.now(),
  );
}

export function getPasskey(sql: SqlStorage, id: string): PasskeyRow | null {
  return sql.exec<PasskeyRow>(`SELECT * FROM passkeys WHERE id = ?`, id).toArray()[0] ?? null;
}

export function bumpPasskey(sql: SqlStorage, id: string, counter: number): void {
  sql.exec(`UPDATE passkeys SET counter = ? WHERE id = ?`, counter, id);
}

/**
 * Checks every key's lock and counts this attempt as a failure against each in one synchronous
 * step, so concurrent attempts can't all pass the check before any is recorded. Returns the
 * failure rowids to clear on success, or null when any key is locked.
 */
export function claimAttempt(sql: SqlStorage, ...keys: FailureKey[]): number[] | null {
  if (keys.some((k) => locked(sql, k))) return null;
  const now = Date.now();
  return keys.map((k) => sql.exec<{ id: number }>(`INSERT INTO auth_failures (kind, at) VALUES (?, ?) RETURNING rowid AS id`, k, now).one().id);
}

export function clearAttempt(sql: SqlStorage, ids: number[]): void {
  for (const id of ids) sql.exec(`DELETE FROM auth_failures WHERE rowid = ?`, id);
}

export function locked(sql: SqlStorage, kind: FailureKey): boolean {
  const since = Date.now() - LOCK_WINDOW_MS;
  sql.exec(`DELETE FROM auth_failures WHERE at < ?`, since);
  const { n } = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_failures WHERE kind = ? AND at >= ?`, kind, since).one();
  return n >= limitFor(kind);
}

export function devices(sql: SqlStorage, currentSessionId: string | null): Devices {
  const machines = sql
    .exec<{ id: string; name: string; created_at: number; last_used: number | null }>(
      `SELECT id, name, created_at, last_used FROM machine_tokens ORDER BY created_at`,
    )
    .toArray();
  const sessions = sql
    .exec<{ id: string; kind: SessionKind; label: string; created_at: number; last_used: number }>(
      `SELECT id, kind, label, created_at, last_used FROM auth_sessions WHERE expires_at >= ? ORDER BY created_at`,
      Date.now(),
    )
    .toArray();
  const widgets: Devices["widgets"] = [];
  const browsers: Devices["browsers"] = [];
  for (const { kind, ...s } of sessions) {
    if (kind === "widget") widgets.push(s);
    else browsers.push({ ...s, current: s.id === currentSessionId });
  }
  const passkeys = sql.exec<{ id: string; name: string; created_at: number }>(`SELECT id, name, created_at FROM passkeys ORDER BY created_at`).toArray();
  return { machines, widgets, browsers, passkeys };
}

/** Deletes the device. Returns the auth session ids it ended, so their sockets can close, or null when not found. */
export function revoke(sql: SqlStorage, kind: DeviceKind, id: string): string[] | null {
  if (kind === "widget" || kind === "browser")
    return sql.exec(`DELETE FROM auth_sessions WHERE id = ? AND kind = ?`, id, kind).rowsWritten ? [id] : null;
  const table = kind === "machine" ? "machine_tokens" : "passkeys";
  if (!sql.exec(`DELETE FROM ${table} WHERE id = ?`, id).rowsWritten) return null;
  if (kind === "machine") return [];
  sql.exec(`DELETE FROM machine_tokens WHERE passkey_id = ?`, id);
  sql.exec(`DELETE FROM pairing_codes WHERE passkey_id = ?`, id);
  sql.exec(`DELETE FROM device_codes WHERE passkey_id = ?`, id);
  return sql.exec<{ id: string }>(`DELETE FROM auth_sessions WHERE passkey_id = ? RETURNING id`, id).toArray().map((r) => r.id);
}
