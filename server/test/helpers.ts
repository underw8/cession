import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";
import type { SessionKind } from "../src/authstore";
import type { SessionRow, Snapshot } from "../src/hub";
import { SoftAuthenticator } from "./authenticator";

export const BASE = "http://localhost";
// The harness binds DEV_SKIP_AUTH=1; this env enforces the real session gate.
export const authEnv = { ...env, DEV_SKIP_AUTH: undefined } as unknown as Env;

let shared: Promise<string> | undefined;
/** One machine token for every test that just needs to ingest. */
export const machineToken = () => (shared ??= hub().createMachineToken("test").then((t) => t!.token));

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

// Not tied to a passkey, so creation always succeeds.
export const newSession = async (kind: SessionKind, label: string) => (await hub().createSession(kind, label))!;
export const newPairingCode = async () => (await hub().createPairingCode())!;

/** Runs SQL directly in the Hub's storage. */
export const sql = <T extends Record<string, SqlStorageValue>>(query: string, ...args: unknown[]) =>
  runInDurableObject(hub(), (_i, state) => state.storage.sql.exec<T>(query, ...args).toArray());

/** Reads a row directly, including final (stale/ended) sessions the API hides. */
export const row = async (id: string) => (await sql<SessionRow>("SELECT * FROM sessions WHERE id = ?", id))[0];

export async function liveSession(id: string): Promise<SessionRow | undefined> {
  const snap = await (await get("/api/sessions")).json<Snapshot>();
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

export const SETUP = "s3tup-0123456789abcdef0123456789abcdef";
/** authEnv plus a setup code, so tests can register passkeys. */
export const setupEnv = { ...authEnv, SETUP_CODE: SETUP } as Env;

/** POSTs JSON, or GETs when body is omitted; an explicit env or cookie overrides the signed-in-setup default. */
export function call(path: string, body?: unknown, cookie?: string, e: Env = setupEnv, ip?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "vitest" };
  if (cookie) headers.Cookie = `__Host-cession=${cookie}`;
  if (ip) headers["CF-Connecting-IP"] = ip;
  return fetchWith(path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }, e);
}

const postJson = (path: string, body: unknown, ip?: string) => call(path, body, undefined, setupEnv, ip);

/** A fresh user-verified assertion from auth, signed over a new login challenge. */
export async function assertion(auth: SoftAuthenticator, ip?: string) {
  const opts = await postJson("/auth/login/options", {}, ip);
  if (opts.status !== 200) throw new Error(`login options: ${opts.status}`);
  return auth.login((await opts.json()) as PublicKeyCredentialRequestOptionsJSON, BASE);
}

/** Starts registration with the given body (the setup code by default) and signs the returned options. */
export async function register(auth: SoftAuthenticator, body: object = { setup_code: SETUP }, cookie?: string) {
  const opts = await call("/auth/register/options", body, cookie);
  expect(opts.status).toBe(200);
  return { response: await auth.register((await opts.json()) as PublicKeyCredentialCreationOptionsJSON, BASE) };
}

/** Registers a passkey with the setup code; returns its authenticator, id and browser session cookie. */
export async function owner() {
  const auth = await SoftAuthenticator.create();
  const { response } = await register(auth);
  return { auth, id: response.id, cookie: cookieOf(await call("/auth/register/verify", { response }))! };
}
