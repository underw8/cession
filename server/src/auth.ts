import type { Session } from "./authstore";
import type { Hub } from "./hub";

// Matches randomToken("cs_") / randomToken("") in authstore.ts: a "cs_" prefix (or none) plus
// unpadded base64url of 32 random bytes. A value of the wrong shape can't be a real token or
// session, so it's rejected here without spending a Hub call on it.
const TOKEN_RE = /^cs_[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;

/** Machine tokens are looked up by hash, so the comparison leaks no timing about the token. */
export async function ingestAuthorized(req: Request, hub: DurableObjectStub<Hub>): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return TOKEN_RE.test(token) && hub.checkMachineToken(token);
}

export const isLocalhost = (req: Request) => ["localhost", "127.0.0.1"].includes(new URL(req.url).hostname);

export async function readSession(
  req: Request,
  env: Env,
  hub: DurableObjectStub<Hub>,
): Promise<Session | null> {
  // A deployed Worker is reachable at *.workers.dev or a custom domain, never "localhost", so a
  // stray DEV_SKIP_AUTH=1 can't disable auth once deployed.
  if (env.DEV_SKIP_AUTH === "1" && isLocalhost(req)) return { id: "dev", kind: "browser", passkey_id: null };
  const raw = req.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-cession=([^;]+)/)?.[1];
  return raw && SESSION_RE.test(raw) ? hub.getSession(raw) : null;
}

// Max-Age is the browser's 400-day cap; the server-side sliding expires_at decides validity.
export const sessionCookie = (raw: string) =>
  `__Host-cession=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`;

export const clearCookie = () => `__Host-cession=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(req.url).origin;
}

// /auth/pair accepts no Origin at all, the Worker's own origin, or the widget's fixed scheme;
// anything else - including a sandboxed iframe's "null" - is a forged pairing post.
export function allowedPairOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(req.url).origin || origin === "tauri://localhost";
}

/** The caller's /64 and, for IPv6, its /48, since one tenant can own a whole /48. */
export const clientKeys = (req: Request) => [...new Set([clientKey(req), clientKey(req, 48)])];

export const status = (code: number, text = "") => new Response(text || null, { status: code });

export const isWidget = (req: Request) => (req.headers.get("User-Agent") ?? "").includes("cession-widget");

/** Lockout key for the caller: the IPv4 address, or the IPv6 /64 (one host can own a whole /64), or /48 when asked. */
export function clientKey(req: Request, bits: 64 | 48 = 64): string {
  const ip = (req.headers.get("CF-Connecting-IP") ?? "").trim().toLowerCase().split("%")[0];
  if (isV4(ip)) return ip;
  const tail = ip.slice(ip.lastIndexOf(":") + 1);
  const mapped = tail.includes(".");
  if (mapped && !isV4(tail)) return "unknown";
  const groups = v6Groups(mapped ? `${ip.slice(0, -tail.length)}0:0` : ip);
  if (!groups) return "unknown";
  return mapped ? tail : `${groups.slice(0, bits / 16).map((g) => Number.parseInt(g, 16).toString(16)).join(":")}::/${bits}`;
}

const isV4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split(".").every((o) => Number(o) <= 255);

/** The 8 hextets of an IPv6 address, or null when malformed. */
function v6Groups(ip: string): string[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const [left, right] = halves.map((h) => (h ? h.split(":") : []));
  const parts = [...left, ...(right ?? [])];
  if (!parts.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (right === undefined) return parts.length === 8 ? parts : null;
  if (parts.length > 7) return null;
  return [...left, ...new Array(8 - parts.length).fill("0"), ...right];
}
