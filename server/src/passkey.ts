import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import { clearCookie, clientKeys, readSession, sessionCookie, status } from "./auth";
import type { Hub } from "./hub";

type Body = { setup_code?: unknown; name?: string; response?: RegistrationResponseJSON & AuthenticationResponseJSON; assertion?: unknown };

const SETUP_CODE_MIN = 32;
const MAX_SETUP_CODE = 256;
// Credential ids are at most 1023 bytes (about 1364 base64url chars); bounds what reaches the Hub.
const MAX_ASSERTION_FIELD = 2048;
const USER_ID = new TextEncoder().encode("owner") as Uint8Array<ArrayBuffer>;

const wellFormed = (r: unknown): r is AuthenticationResponseJSON => {
  const a = r as { id?: unknown; response?: { clientDataJSON?: unknown } } | null;
  return typeof a?.id === "string" && a.id.length <= MAX_ASSERTION_FIELD &&
    typeof a.response?.clientDataJSON === "string" && a.response.clientDataJSON.length <= MAX_ASSERTION_FIELD;
};

async function withSession(hub: DurableObjectStub<Hub>, req: Request, passkeyId: string): Promise<Response> {
  const raw = await hub.createSession("browser", (req.headers.get("User-Agent") ?? "browser").slice(0, 60), passkeyId);
  return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(raw) } });
}

/** Checks a user-verified assertion against a login challenge; returns the passkey id, or null. */
async function verifyAssertion(hub: DurableObjectStub<Hub>, response: AuthenticationResponseJSON, url: URL): Promise<string | null> {
  try {
    // Consume the challenge before any other check so every failed attempt burns it.
    const { challenge } = decodeClientDataJSON(response.response.clientDataJSON);
    const fresh = await hub.takeChallenge(challenge, "login");
    const passkey = await hub.getPasskey(response.id);
    if (!fresh || !passkey) return null;
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
    });
    if (!verified) return null;
    await hub.bumpPasskey(passkey.id, authenticationInfo.newCounter);
    return passkey.id;
  } catch {
    return null;
  }
}

/** Handles POST /auth/{register,login}/{options,verify} and /auth/logout; undefined for anything else. */
export async function passkeyRoute(req: Request, env: Env, hub: DurableObjectStub<Hub>): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (req.method !== "POST" || !url.pathname.startsWith("/auth/")) return undefined;
  const rpID = url.hostname;
  // A body of JSON null, or any non-object, reads as empty so bad input gets 400, not a TypeError.
  const parsed = await req.json<Body>().catch(() => null);
  const body: Body = typeof parsed === "object" && parsed !== null ? parsed : {};
  const session = await readSession(req, env, hub);
  // Only a browser may add passkeys without the setup code; a widget would escalate to browser scope.
  const browser = session?.kind === "browser";
  // Per client prefix, so a stranger's failures can't lock the owner out.
  const ips = clientKeys(req);

  switch (url.pathname) {
    case "/auth/register/options": {
      if (browser) {
        // A stolen cookie alone must not add a passkey that outlives the owner's: verify the user again.
        if (!wellFormed(body.assertion)) return status(401, "reauthenticate");
        if (!(await verifyAssertion(hub, body.assertion, url))) return status(401);
      } else {
        if (!env.SETUP_CODE) return status(401);
        if (env.SETUP_CODE.length < SETUP_CODE_MIN) return status(401, `SETUP_CODE must be at least ${SETUP_CODE_MIN} characters`);
        const code = typeof body.setup_code === "string" ? body.setup_code : "";
        if (code.length > MAX_SETUP_CODE) return status(400);
        const result = await hub.trySetupCode(code, env.SETUP_CODE, ...ips);
        if (result === "locked") return status(429);
        if (result === "bad") return status(401);
      }
      const options = await generateRegistrationOptions({
        rpName: "cession",
        rpID,
        userID: USER_ID,
        userName: "owner",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      await hub.putChallenge(options.challenge, "register");
      return Response.json(options);
    }

    case "/auth/register/verify": {
      if (!body.response) return status(400);
      let passkeyId: string;
      try {
        const { verified, registrationInfo } = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: (c) => hub.takeChallenge(c, "register"),
          expectedOrigin: url.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
        if (!verified) return status(400);
        const { credential } = registrationInfo;
        passkeyId = credential.id;
        await hub.addPasskey({
          id: credential.id,
          public_key: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ? JSON.stringify(credential.transports) : null,
          name: (body.name || "passkey").slice(0, 60),
        });
      } catch {
        return status(400);
      }
      return browser ? status(204) : withSession(hub, req, passkeyId);
    }

    case "/auth/login/options": {
      // Every call stores a challenge row, so budget them per client prefix; never cleared.
      if ((await hub.claimAttempt(...ips.map((ip) => `login_opts:${ip}` as const))) === null) return status(429);
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
      await hub.putChallenge(options.challenge, "login");
      return Response.json(options);
    }

    // No failure lockout: signatures can't be guessed, and a lock would let anyone behind the
    // owner's NAT lock them out. The challenge budget above bounds the work.
    case "/auth/login/verify": {
      if (!wellFormed(body.response)) return status(400);
      const passkeyId = await verifyAssertion(hub, body.response, url);
      return passkeyId ? withSession(hub, req, passkeyId) : status(401);
    }

    case "/auth/logout": {
      if (session) await hub.revoke(session.kind, session.id);
      return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookie() } });
    }
  }
  return undefined;
}
