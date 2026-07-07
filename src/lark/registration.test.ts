import { describe, it, expect } from "vitest";
import {
  beginFeishuRegistration,
  initFeishuRegistration,
  pollFeishuRegistration,
  renderQrToTerminal,
  type FeishuRegistrationTransport,
} from "./registration.js";

type TransportCall = {
  readonly url: string;
  readonly body: Readonly<Record<string, string>>;
};

function makeTransport(responses: readonly unknown[]): {
  readonly calls: readonly TransportCall[];
  readonly transport: FeishuRegistrationTransport;
} {
  const calls: TransportCall[] = [];
  let index = 0;
  return {
    calls,
    transport: async (url, body) => {
      calls.push({ url, body: Object.fromEntries(body.entries()) });
      const response = responses[index];
      index += 1;
      return response ?? {};
    },
  };
}

describe("Feishu link-to-create registration client", () => {
  it("verifies that client_secret auth is supported", async () => {
    const { transport, calls } = makeTransport([
      { nonce: "abc", supported_auth_methods: ["client_secret"] },
    ]);

    await initFeishuRegistration({ domain: "feishu", transport });

    expect(calls).toEqual([
      {
        url: "https://accounts.feishu.cn/oauth/v1/app/registration",
        body: { action: "init" },
      },
    ]);
  });

  it("rejects registration environments without client_secret auth", async () => {
    const { transport } = makeTransport([{ supported_auth_methods: ["private_key_jwt"] }]);

    await expect(initFeishuRegistration({ domain: "feishu", transport })).rejects.toThrow(
      /client_secret/,
    );
  });

  it("begins a PersonalAgent registration and returns the setup URL without leaking codes", async () => {
    const { transport, calls } = makeTransport([
      {
        device_code: "device-secret",
        verification_uri_complete: "https://open.feishu.cn/page/launcher?x=1",
        user_code: "user-secret",
        interval: 5,
        expires_in: 600,
      },
    ]);

    const result = await beginFeishuRegistration({ domain: "feishu", transport });

    expect(calls[0]?.body).toEqual({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    expect(result.deviceCode).toBe("device-secret");
    expect(result.qrUrl).toBe("https://open.feishu.cn/page/launcher?x=1&from=humming&tp=humming");
    expect(result.intervalSeconds).toBe(5);
    expect(result.expiresInSeconds).toBe(600);
  });

  it("polls until credentials are returned and maps client fields to Humming credentials", async () => {
    const { transport, calls } = makeTransport([
      { error: "authorization_pending" },
      {
        client_id: "cli_created",
        client_secret: "created-secret",
        user_info: { open_id: "owner-open-id", tenant_brand: "feishu" },
      },
    ]);

    const result = await pollFeishuRegistration({
      domain: "feishu",
      deviceCode: "device-secret",
      intervalSeconds: 0,
      timeoutSeconds: 60,
      transport,
      sleep: async () => {},
      now: makeClock([0, 1, 2]),
    });

    expect(calls.map((call) => call.body)).toEqual([
      { action: "poll", device_code: "device-secret", tp: "ob_app" },
      { action: "poll", device_code: "device-secret", tp: "ob_app" },
    ]);
    expect(result).toEqual({
      appId: "cli_created",
      appSecret: "created-secret",
      domain: "feishu",
      ownerOpenId: "owner-open-id",
    });
  });

  it("switches to Lark polling when the tenant brand says lark", async () => {
    const { transport, calls } = makeTransport([
      { error: "authorization_pending", user_info: { tenant_brand: "lark" } },
      {
        client_id: "cli_lark",
        client_secret: "lark-secret",
        user_info: { tenant_brand: "lark" },
      },
    ]);

    const result = await pollFeishuRegistration({
      domain: "feishu",
      deviceCode: "device-secret",
      intervalSeconds: 0,
      timeoutSeconds: 60,
      transport,
      sleep: async () => {},
      now: makeClock([0, 1, 2]),
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://accounts.feishu.cn/oauth/v1/app/registration",
      "https://accounts.larksuite.com/oauth/v1/app/registration",
    ]);
    expect(result?.domain).toBe("lark");
  });

  it("does not render terminal QR codes for the current link-based flow", async () => {
    await expect(
      renderQrToTerminal("https://example.com/qr", {
        render: async () => {},
      }),
    ).resolves.toBe(false);
  });
});

function makeClock(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value ?? 0;
  };
}
