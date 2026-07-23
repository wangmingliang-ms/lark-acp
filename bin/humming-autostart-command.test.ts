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

  it("describes a disable", () => {
    const msg = formatAutostartReport({
      kind: "disabled",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x-boot.service",
    });
    expect(msg).toContain("disabled");
    expect(msg).toContain("systemd");
  });

  it("describes an already-disabled", () => {
    const msg = formatAutostartReport({
      kind: "already-disabled",
      mechanism: "windows-task",
      path: "Humming Gateway Autostart",
    });
    expect(msg).toContain("already disabled");
  });

  it("describes an enable", () => {
    const msg = formatAutostartReport({
      kind: "enabled",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x-boot.service",
    });
    expect(msg).toContain("enabled");
    expect(msg).toContain("systemd");
  });

  it("describes a not-installed enable attempt", () => {
    const msg = formatAutostartReport({
      kind: "not-installed",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x-boot.service",
    });
    expect(msg).toContain("not installed");
  });

  it("describes an uninstall", () => {
    const msg = formatAutostartReport({
      kind: "uninstalled",
      mechanism: "windows-task",
      path: "Humming Gateway Autostart",
    });
    expect(msg).toContain("uninstalled");
  });

  it("describes an already-uninstalled", () => {
    const msg = formatAutostartReport({
      kind: "already-uninstalled",
      mechanism: "systemd",
      path: "/home/u/.config/systemd/user/x-boot.service",
    });
    expect(msg).toContain("already uninstalled");
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
