import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LarkLogger } from "../logger/logger.js";

const sdkMocks = vi.hoisted(() => ({
  createReaction: vi.fn(),
  deleteReaction: vi.fn(),
  createImage: vi.fn(),
  replyMessage: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self-build" },
  LoggerLevel: { error: "error" },
  Client: class {
    readonly im = {
      message: {
        reply: sdkMocks.replyMessage,
      },
      v1: {
        messageReaction: {
          create: sdkMocks.createReaction,
          delete: sdkMocks.deleteReaction,
        },
        image: {
          create: sdkMocks.createImage,
        },
      },
    };
  },
}));

import { LarkApiError, LarkHttpClient, LarkMalformedResponseError } from "./lark-http.js";

const silentLogger: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return silentLogger;
  },
};

function createClient(): LarkHttpClient {
  return new LarkHttpClient({ appId: "app-id", appSecret: "app-secret", logger: silentLogger });
}

beforeEach(() => {
  sdkMocks.createReaction.mockReset();
  sdkMocks.deleteReaction.mockReset();
  sdkMocks.createImage.mockReset();
  sdkMocks.replyMessage.mockReset();
});

describe("LarkHttpClient message reactions", () => {
  it("adds the requested emoji reaction and returns its reaction id", async () => {
    sdkMocks.createReaction.mockResolvedValue({ code: 0, data: { reaction_id: "reaction/123" } });
    const client = createClient();

    await expect(client.addMessageReaction("message/123", "THUMBSUP")).resolves.toBe(
      "reaction/123",
    );
    expect(sdkMocks.createReaction).toHaveBeenCalledWith({
      path: { message_id: "message/123" },
      data: { reaction_type: { emoji_type: "THUMBSUP" } },
    });
  });

  it("removes the exact reaction from its message", async () => {
    sdkMocks.deleteReaction.mockResolvedValue({ code: 0 });
    const client = createClient();

    await expect(
      client.removeMessageReaction("message/123", "reaction/456"),
    ).resolves.toBeUndefined();
    expect(sdkMocks.deleteReaction).toHaveBeenCalledWith({
      path: { message_id: "message/123", reaction_id: "reaction/456" },
    });
  });

  it("rejects a successful create response without a reaction id", async () => {
    sdkMocks.createReaction.mockResolvedValue({ code: 0, data: {} });
    const client = createClient();

    await expect(client.addMessageReaction("message-id", "OK")).rejects.toBeInstanceOf(
      LarkMalformedResponseError,
    );
  });

  it("rejects a create API error response", async () => {
    sdkMocks.createReaction.mockResolvedValue({ code: 230001, msg: "message not found" });
    const client = createClient();

    await expect(client.addMessageReaction("message-id", "OK")).rejects.toMatchObject({
      name: LarkApiError.name,
      code: 230001,
      operation: "messageReaction.create",
    });
  });

  it("rejects a delete API error response", async () => {
    sdkMocks.deleteReaction.mockResolvedValue({ code: 230002, msg: "reaction not found" });
    const client = createClient();

    await expect(client.removeMessageReaction("message-id", "reaction-id")).rejects.toMatchObject({
      name: LarkApiError.name,
      code: 230002,
      operation: "messageReaction.delete",
    });
  });

  it("propagates reaction transport errors without swallowing them", async () => {
    const transportError = new Error("network unavailable");
    sdkMocks.createReaction.mockRejectedValue(transportError);
    sdkMocks.deleteReaction.mockRejectedValue(transportError);
    const client = createClient();

    await expect(client.addMessageReaction("message-id", "OK")).rejects.toBe(transportError);
    await expect(client.removeMessageReaction("message-id", "reaction-id")).rejects.toBe(
      transportError,
    );
  });
});

describe("LarkHttpClient outbound images", () => {
  it("uploads bytes as an image_type message and returns the image_key", async () => {
    sdkMocks.createImage.mockResolvedValue({ image_key: "img_v3_abc" });
    const client = createClient();

    await expect(client.uploadImage(Buffer.from([1, 2, 3]))).resolves.toBe("img_v3_abc");
    const call = sdkMocks.createImage.mock.calls[0]?.[0] as {
      data: { image_type: string; image: unknown };
    };
    expect(call.data.image_type).toBe("message");
    expect(Buffer.isBuffer(call.data.image)).toBe(true);
  });

  it("rejects an upload response without an image_key", async () => {
    sdkMocks.createImage.mockResolvedValue({});
    const client = createClient();

    await expect(client.uploadImage(Buffer.from([1]))).rejects.toBeInstanceOf(
      LarkMalformedResponseError,
    );
  });

  it("rejects a null upload response", async () => {
    sdkMocks.createImage.mockResolvedValue(null);
    const client = createClient();

    await expect(client.uploadImage(Buffer.from([1]))).rejects.toBeInstanceOf(
      LarkMalformedResponseError,
    );
  });

  it("propagates an upload transport/API rejection", async () => {
    const apiError = new Error("image too large");
    sdkMocks.createImage.mockRejectedValue(apiError);
    const client = createClient();

    await expect(client.uploadImage(Buffer.from([1]))).rejects.toBe(apiError);
  });

  it("replies with an image message carrying the image_key", async () => {
    sdkMocks.replyMessage.mockResolvedValue({ code: 0, data: { message_id: "om_reply" } });
    const client = createClient();

    await expect(client.replyImage("om_anchor", "img_v3_abc")).resolves.toBe("om_reply");
    expect(sdkMocks.replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om_anchor" },
      data: {
        content: JSON.stringify({ image_key: "img_v3_abc" }),
        msg_type: "image",
      },
    });
  });
});
