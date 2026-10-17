import { describe, expect, it } from "vitest";
import { clientKey, ingestAuthorized } from "../src/auth";
import type { Hub } from "../src/hub";
import { hub, post, uid } from "./helpers";

const req = (headers: Record<string, string> = {}) => new Request("https://x.test/", { headers });
const onlyToken = (good: string) => ({ checkMachineToken: async (t: string) => t === good }) as unknown as DurableObjectStub<Hub>;

describe("ingestAuthorized", () => {
  it("accepts a known machine token as a bearer token", async () => {
    expect(await ingestAuthorized(req({ Authorization: "Bearer cs_good" }), onlyToken("cs_good"))).toBe(true);
  });
  it.each([[{}], [{ Authorization: "Bearer " }], [{ Authorization: "Bearer cs_bad" }], [{ Authorization: "cs_good" }]])(
    "rejects %j",
    async (headers) => expect(await ingestAuthorized(req(headers), onlyToken("cs_good"))).toBe(false),
  );
  it("rejects an unknown bearer token end to end", async () => {
    expect((await post("/v1/metrics", {}, "cs_nope")).status).toBe(401);
  });
});

describe("machine tokens", () => {
  it("accepts a token from createMachineToken, rejects it after revoke", async () => {
    const { id, token } = await hub().createMachineToken("t");
    const sessionId = uid();
    const validEvent = { session_id: sessionId, event: "SessionStart", ts: Date.now() };

    expect((await post("/events", validEvent, token)).status).toBe(204);

    expect(await hub().revoke("machine", id)).toBe(true);
    expect((await post("/events", validEvent, token)).status).toBe(401);
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
