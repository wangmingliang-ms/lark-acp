import { describe, it, expect } from "vitest";
import {
  detectAutostartTarget,
  ensureAutostart,
  disableAutostart,
  enableAutostart,
  uninstallAutostart,
  queryAutostart,
  type AutostartRuntime,
} from "./autostart.js";

describe("detectAutostartTarget", () => {
  it("returns windows-task on win32", () => {
    expect(detectAutostartTarget({ platform: "win32", systemdAvailable: false })).toBe(
      "windows-task",
    );
  });

  it("returns systemd on linux with user systemd", () => {
    expect(detectAutostartTarget({ platform: "linux", systemdAvailable: true })).toBe("systemd");
  });

  it("returns unsupported on linux without user systemd", () => {
    const result = detectAutostartTarget({ platform: "linux", systemdAvailable: false });
    expect(result).toEqual({ unsupported: expect.stringContaining("systemd") });
  });

  it("returns unsupported on darwin", () => {
    const result = detectAutostartTarget({ platform: "darwin", systemdAvailable: false });
    expect(result).toEqual({ unsupported: expect.stringContaining("darwin") });
  });
});

function baseRuntime(overrides: Partial<AutostartRuntime>): AutostartRuntime {
  return {
    env: { platform: "linux", systemdAvailable: true },
    installSystemd: () => ({ kind: "installed", mechanism: "systemd", path: "/unit" }),
    installWindows: () => ({ kind: "installed", mechanism: "windows-task", path: "task" }),
    disableSystemd: () => ({ kind: "disabled", mechanism: "systemd", path: "/unit" }),
    disableWindows: () => ({ kind: "disabled", mechanism: "windows-task", path: "task" }),
    enableSystemd: () => ({ kind: "enabled", mechanism: "systemd", path: "/unit" }),
    enableWindows: () => ({ kind: "enabled", mechanism: "windows-task", path: "task" }),
    uninstallSystemd: () => ({ kind: "uninstalled", mechanism: "systemd", path: "/unit" }),
    uninstallWindows: () => ({ kind: "uninstalled", mechanism: "windows-task", path: "task" }),
    querySystemd: () => ({ kind: "enabled", mechanism: "systemd", path: "/unit" }),
    queryWindows: () => ({ kind: "enabled", mechanism: "windows-task", path: "task" }),
    ...overrides,
  };
}

describe("ensureAutostart", () => {
  it("dispatches to systemd installer on linux", () => {
    const report = ensureAutostart(baseRuntime({}));
    expect(report).toEqual({ kind: "installed", mechanism: "systemd", path: "/unit" });
  });

  it("dispatches to windows installer on win32", () => {
    const report = ensureAutostart(
      baseRuntime({ env: { platform: "win32", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("installed");
    expect(report).toHaveProperty("mechanism", "windows-task");
  });

  it("skips with a reason on unsupported platform", () => {
    const report = ensureAutostart(
      baseRuntime({ env: { platform: "darwin", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("skipped");
    if (report.kind === "skipped") expect(report.reason).toContain("darwin");
  });
});

describe("disableAutostart", () => {
  it("dispatches to systemd disabler on linux", () => {
    const report = disableAutostart(baseRuntime({}));
    expect(report).toEqual({ kind: "disabled", mechanism: "systemd", path: "/unit" });
  });

  it("dispatches to windows disabler on win32", () => {
    const report = disableAutostart(
      baseRuntime({ env: { platform: "win32", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("disabled");
    expect(report).toHaveProperty("mechanism", "windows-task");
  });

  it("skips with a reason on unsupported platform", () => {
    const report = disableAutostart(
      baseRuntime({ env: { platform: "darwin", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("skipped");
  });
});

describe("enableAutostart", () => {
  it("dispatches to systemd enabler on linux", () => {
    const report = enableAutostart(baseRuntime({}));
    expect(report).toEqual({ kind: "enabled", mechanism: "systemd", path: "/unit" });
  });

  it("dispatches to windows enabler on win32", () => {
    const report = enableAutostart(
      baseRuntime({ env: { platform: "win32", systemdAvailable: false } }),
    );
    expect(report).toHaveProperty("mechanism", "windows-task");
  });

  it("skips on unsupported platform", () => {
    const report = enableAutostart(
      baseRuntime({ env: { platform: "darwin", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("skipped");
  });
});

describe("uninstallAutostart", () => {
  it("dispatches to systemd uninstaller on linux", () => {
    const report = uninstallAutostart(baseRuntime({}));
    expect(report).toEqual({ kind: "uninstalled", mechanism: "systemd", path: "/unit" });
  });

  it("dispatches to windows uninstaller on win32", () => {
    const report = uninstallAutostart(
      baseRuntime({ env: { platform: "win32", systemdAvailable: false } }),
    );
    expect(report).toHaveProperty("mechanism", "windows-task");
  });

  it("skips on unsupported platform", () => {
    const report = uninstallAutostart(
      baseRuntime({ env: { platform: "darwin", systemdAvailable: false } }),
    );
    expect(report.kind).toBe("skipped");
  });
});

describe("queryAutostart", () => {
  it("dispatches to systemd query on linux", () => {
    const status = queryAutostart(baseRuntime({}));
    expect(status).toEqual({ kind: "enabled", mechanism: "systemd", path: "/unit" });
  });

  it("dispatches to windows query on win32", () => {
    const status = queryAutostart(
      baseRuntime({ env: { platform: "win32", systemdAvailable: false } }),
    );
    expect(status).toHaveProperty("mechanism", "windows-task");
  });

  it("reports unsupported on darwin", () => {
    const status = queryAutostart(
      baseRuntime({ env: { platform: "darwin", systemdAvailable: false } }),
    );
    expect(status.kind).toBe("unsupported");
  });
});
