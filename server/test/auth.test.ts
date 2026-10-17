import { describe, expect, it } from "vitest";
import { clientKey, ingestAuthorized } from "../src/auth";
import type { Hub } from "../src/hub";
import { TOKEN, hub, post, uid } from "./helpers";

const env = { INGEST_TOKEN: "t0ken" } as unknown as Env;
const req = (headers: Record<string, string> = {}) => new Request("https://x.test/", { headers });
const noMachineTokens = { checkIngestToken: async () => false } as unknown as DurableObjectStub<Hub>;

describe("ingestAuthorized", () => {
  it("accepts the exact bearer token", async () => {
    expect(await ingestAuthorized(req({ Authorization: "Bearer t0ken" }), env, noMachineTokens)).toBe(true);
  });
  it.each([[{}], [{ Authorization: "Bearer wrong" }], [{ Authorization: "Bearer t0ken2" }], [{ Authorization: "t0ken" }]])(
    "rejects %j",
    async (headers) => expect(await ingestAuthorized(req(headers), env, noMachineTokens)).toBe(false),
  );
  it("rejects everything when INGEST_TOKEN is unset and no machine token matches", async () => {
    const noToken = { ...env, INGEST_TOKEN: "" } as unknown as Env;
    expect(await ingestAuthorized(req({ Authorization: "Bearer " }), noToken, noMachineTokens)).toBe(false);
  });
  it("rejects a bearer token that isn't the legacy token and isn't a known machine token", async () => {
    expect((await post("/v1/metrics", {}, "cs_nope")).status).toBe(401);
  });
});

describe("per-machine ingest tokens", () => {
  it("accepts a token from createMachineToken, rejects it after revoke", async () => {
    const { id, token } = await hub().createMachineToken("t");
    const sessionId = uid();
    const validEvent = { session_id: sessionId, event: "SessionStart", ts: Date.now() };

    expect((await post("/events", validEvent, token)).status).toBe(204);

    expect(await hub().revoke("machine", id)).toBe(true);
    expect((await post("/events", validEvent, token)).status).toBe(401);
  });

  it("still accepts the legacy INGEST_TOKEN", async () => {
    const sessionId = uid();
    const validEvent = { session_id: sessionId, event: "SessionStart", ts: Date.now() };
    expect((await post("/events", validEvent, TOKEN)).status).toBe(204);
  });
});


describe("clientKey", () => {
  const key = (ip?: string) => clientKey(new Request("http://localhost/", { headers: ip ? { "CF-Connecting-IP": ip } : {} }));

  it("keeps IPv4 and reduces IPv6 to its normalised /64", () => {
    expect(key("192.0.2.1")).toBe("192.0.2.1");
    expect(key("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(key("2001:0DB8:0001:0002:ffff:0:0:1")).toBe("2001:db8:1:2::/64");
    expect(key("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(key("::1")).toBe("0:0:0:0::/64");
    expect(key("2001:db8:1:3::1")).not.toBe(key("2001:db8:1:2::1"));
    expect(key("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(key()).toBe("unknown");
  });

  it.each(["1:2:3:4:5:6:7:8:9::1", "a::b::c", "zzzz::1", "", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "12345::1", "999.1.1.1", "1.2.3", "::ffff:1.2.3.999", "not-an-ip"])(
    "maps malformed %j to unknown without throwing",
    (ip) => {
      expect(clientKey(new Request("http://localhost/", { headers: { "CF-Connecting-IP": ip } }))).toBe("unknown");
    },
  );
});
