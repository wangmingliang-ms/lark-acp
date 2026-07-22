import { describe, it, expect } from "vitest";
import { formatAutostartReport } from "./cli/commands/autostart.js";
import { runInit } from "./cli/commands/init.js";
import { runUpdate } from "./cli/commands/update.js";

describe("formatAutostartReport", () => {
  it("describes an install", () => {
    const msg = formatAutostartReport({
      kind: "installed",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x.service",
    });
    expect(msg).toContain("installed");
    expect(msg).toContain("systemd");
  });

  it("describes a skip", () => {
    const msg = formatAutostartReport({ kind: "skipped", reason: "unsupported platform: darwin" });
    expect(msg).toContain("skipped");
    expect(msg).toContain("darwin");
  });
});

describe("init/update autostart wiring contract", () => {
  it("runInit accepts a selfPath argument", () => {
    expect(runInit.length).toBeGreaterThanOrEqual(2);
  });
  it("runUpdate is a function", () => {
    expect(typeof runUpdate).toBe("function");
  });
});
