import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import worker from "../src/index";
import type { SessionRow, Snapshot } from "../src/hub";

export const BASE = "http://localhost";
// The harness binds DEV_SKIP_AUTH=1; this env enforces the real session gate.
export const authEnv = { ...env, DEV_SKIP_AUTH: undefined } as unknown as Env;

let shared: Promise<string> | undefined;
/** One machine token for every test that just needs to ingest. */
export const machineToken = () => (shared ??= hub().createMachineToken("test").then((t) => t.token));

export async function post(path: string, body: unknown, token?: string): Promise<Response> {
  token ??= await machineToken();
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function get(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

export function hub() {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

/** Runs SQL directly in the Hub's storage. */
export const sql = <T extends Record<string, SqlStorageValue>>(query: string, ...args: unknown[]) =>
  runInDurableObject(hub(), (_i, state) => state.storage.sql.exec<T>(query, ...args).toArray());

/** Reads a row directly, including final (stale/ended) sessions the API hides. */
export const row = async (id: string) => (await sql<SessionRow>("SELECT * FROM sessions WHERE id = ?", id))[0];

export async function liveSession(id: string): Promise<SessionRow | undefined> {
  const snap = (await (await get("/api/sessions")).json()) as Snapshot;
  return snap.sessions.find((s) => s.id === id);
}

// worker.fetch expects an incoming Request (with Cloudflare's `cf` properties);
// a plain `new Request()` lacks those, so cast past the type mismatch here.
export const asIncoming = (req: Request) => req as unknown as Parameters<typeof worker.fetch>[0];

/** Fetches through the worker with an explicit env, without following redirects. */
export const fetchWith = (path: string, init: RequestInit = {}, e: Env = authEnv) =>
  worker.fetch(asIncoming(new Request(`${BASE}${path}`, { redirect: "manual", ...init })), e);

export const cookieOf = (res: Response) => res.headers.get("Set-Cookie")?.match(/^__Host-cession=([^;]+);/)?.[1];

export const resetFailures = () => sql("DELETE FROM auth_failures");

let n = 0;
export const uid = (prefix = "s") => `${prefix}-${Date.now()}-${n++}`;
