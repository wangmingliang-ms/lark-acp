import { describe, it, expect } from "vitest";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { interpretLarkMessage, type LarkCommand, type PromptSegment } from "./lark-interpreter.js";

/**
 * Build a minimal text-message event. The interpreter only reads
 * `message.message_type`, `message.content` (a JSON string) and
 * `message.mentions`, so the rest is filled with inert placeholders.
 */
function textEvent(
  text: string,
  mentions?: Lark.RawMessageEvent["message"]["mentions"],
): Lark.RawMessageEvent {
  const message = {
    message_id: "om_test",
    chat_id: "oc_test",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text }),
    ...(mentions ? { mentions } : {}),
  };
  // The bridge passes the full event; only `message` matters for text parsing.
  return { message } as unknown as Lark.RawMessageEvent;
}

/**
 * Build a non-text message event. Mirrors {@link textEvent} but lets the
 * caller pick `message_type` and the raw `content` JSON string.
 */
function messageEvent(
  messageType: string,
  content: string,
  messageId = "om_test",
): Lark.RawMessageEvent {
  const message = {
    message_id: messageId,
    chat_id: "oc_test",
    chat_type: "p2p",
    message_type: messageType,
    content,
  };
  return { message } as unknown as Lark.RawMessageEvent;
}

function expectCommand(text: string): LarkCommand {
  const result = interpretLarkMessage(textEvent(text));
  if (result.kind !== "command") {
    throw new Error(`expected command for "${text}", got kind="${result.kind}"`);
  }
  return result.command;
}

describe("interpretLarkMessage — bind commands", () => {
  it("parses `/bind <path> <agent>`", () => {
    expect(expectCommand("/bind ~/workspace/proj claude")).toEqual({
      kind: "bind",
      cwd: "~/workspace/proj",
      agent: "claude",
    });
  });

  it("parses `/bind <path>` with no agent as agent:null", () => {
    expect(expectCommand("/bind /abs/path")).toEqual({
      kind: "bind",
      cwd: "/abs/path",
      agent: null,
    });
  });

  it("keeps a multi-token raw agent command intact", () => {
    expect(expectCommand("/bind ~/proj node ./my-acp.js --port 9000")).toEqual({
      kind: "bind",
      cwd: "~/proj",
      agent: "node ./my-acp.js --port 9000",
    });
  });

  it("treats bare `/bind` as a usage request", () => {
    expect(expectCommand("/bind")).toEqual({ kind: "bind-usage" });
  });

  it("treats `/bind` with only whitespace as a usage request", () => {
    expect(expectCommand("/bind   ")).toEqual({ kind: "bind-usage" });
  });

  it("collapses extra spaces between path and agent", () => {
    expect(expectCommand("/bind   ~/proj    codex")).toEqual({
      kind: "bind",
      cwd: "~/proj",
      agent: "codex",
    });
  });

  it("does NOT match a prefixed lookalike like /bindfoo", () => {
    const result = interpretLarkMessage(textEvent("/bindfoo bar"));
    expect(result.kind).toBe("prompt");
  });
});

describe("interpretLarkMessage — unbind / where", () => {
  it.each(["/unbind", "/unpin"])("parses %s as unbind", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "unbind" });
  });

  it.each(["/where", "/pwd", "/binding"])("parses %s as where", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "where" });
  });

  it("does not treat `/where extra` as a command (exact match only)", () => {
    const result = interpretLarkMessage(textEvent("/where extra"));
    expect(result.kind).toBe("prompt");
  });
});

describe("interpretLarkMessage — existing commands still work", () => {
  it.each(["/cancel", "/stop", "取消", "停止"])("parses %s as cancel", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "cancel" });
  });

  it.each(["/new", "/restart"])("parses %s as new", (token) => {
    expect(expectCommand(token)).toEqual({ kind: "new" });
  });

  it("treats ordinary text as a prompt", () => {
    const result = interpretLarkMessage(textEvent("please fix the bug"));
    expect(result.kind).toBe("prompt");
  });
});

describe("interpretLarkMessage — compact session profile commands", () => {
  it("parses slash-only session profile commands", () => {
    expect(expectCommand("/agent copilot")).toEqual({ kind: "set-agent", agent: "copilot" });
    expect(expectCommand("/agent")).toEqual({ kind: "list-agents" });
    expect(expectCommand("/model gpt-5")).toEqual({ kind: "set-model", model: "gpt-5" });
    expect(expectCommand("/model auto")).toEqual({ kind: "set-model", model: "auto" });
    expect(expectCommand("/model")).toEqual({ kind: "list-models" });
    expect(expectCommand("/mode plan")).toEqual({ kind: "set-mode", mode: "plan" });
    expect(expectCommand("/mode")).toEqual({ kind: "list-modes" });
    expect(expectCommand("/permission alwaysAllow")).toEqual({
      kind: "set-permission",
      permissionMode: "alwaysAllow",
    });
    expect(expectCommand("/permission")).toEqual({ kind: "list-permissions" });
    expect(expectCommand("/profile")).toEqual({ kind: "profile" });
    expect(expectCommand("/help")).toEqual({ kind: "help" });
    expect(expectCommand("/commands")).toEqual({ kind: "help" });
    expect(expectCommand("/capabilities")).toEqual({ kind: "capabilities", agent: null });
    expect(expectCommand("/capabilities codex")).toEqual({ kind: "capabilities", agent: "codex" });
  });

  it("rejects non-slash aliases and lookalikes as ordinary prompts", () => {
    expect(interpretLarkMessage(textEvent("/agentx copilot")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("agent copilot")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("/modelx auto")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("/capabilitiesx codex")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("/capabilities codex extra")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("/profile extra")).kind).toBe("prompt");
  });
});

function expectSegments(event: Lark.RawMessageEvent): PromptSegment[] {
  const result = interpretLarkMessage(event);
  if (result.kind !== "prompt") {
    throw new Error(`expected prompt, got kind="${result.kind}"`);
  }
  return result.segments;
}

describe("interpretLarkMessage — image messages", () => {
  it("emits a single image-ref segment carrying messageId + imageKey", () => {
    const event = messageEvent("image", JSON.stringify({ image_key: "img_abc" }), "om_img");
    expect(expectSegments(event)).toEqual([
      { kind: "image-ref", messageId: "om_img", imageKey: "img_abc" },
    ]);
  });

  it("emits a text segment when image_key is missing", () => {
    const event = messageEvent("image", JSON.stringify({}), "om_img2");
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "[图片消息缺少 image_key]" }]);
  });
});

describe("interpretLarkMessage — post rich text", () => {
  it("preserves text/image order and merges adjacent text", () => {
    const content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "before " },
          { tag: "img", image_key: "img_1" },
          { tag: "text", text: "after" },
        ],
      ],
    });
    const event = messageEvent("post", content, "om_post");
    expect(expectSegments(event)).toEqual([
      { kind: "text", text: "before" },
      { kind: "image-ref", messageId: "om_post", imageKey: "img_1" },
      { kind: "text", text: "after" },
    ]);
  });

  it("returns a single text segment for a post with no images", () => {
    const content = JSON.stringify({
      title: "Hi",
      content: [[{ tag: "text", text: "plain line" }]],
    });
    const event = messageEvent("post", content, "om_post2");
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "**Hi**\n\nplain line" }]);
  });
});

describe("interpretLarkMessage — other attachments stay text", () => {
  it("renders a file message as a text segment (regression)", () => {
    const content = JSON.stringify({ file_name: "a.pdf", file_key: "fk" });
    const event = messageEvent("file", content);
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "[文件: a.pdf (file_key=fk)]" }]);
  });
});
