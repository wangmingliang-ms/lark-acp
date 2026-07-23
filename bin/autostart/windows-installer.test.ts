import { describe, it, expect } from "vitest";
import {
  renderAutostartPs1,
  renderTaskXml,
  installWindowsAutostart,
  disableWindowsAutostart,
  queryWindowsAutostart,
  type WindowsDeps,
} from "./windows-installer.js";

describe("renderAutostartPs1", () => {
  it("starts the gateway and never adds an agent flag", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming" });
    expect(text).toContain("humming gateway start");
    // agent is resolved by `gateway start` at runtime, never baked in.
    expect(text).not.toContain("--agent");
  });
});

describe("renderTaskXml", () => {
  it("renders a BootTrigger task invoking pwsh with the ps1", () => {
    const xml = renderTaskXml({
      description: "Humming gateway autostart",
      pwshPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ps1Path: "C:\\Users\\u\\.humming\\autostart\\humming-autostart.ps1",
      userId: "MACHINE\\u",
    });
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("pwsh.exe");
    expect(xml).toContain("humming-autostart.ps1");
    expect(xml).toContain("<UserId>MACHINE\\u</UserId>");
  });
});

function fakeWinDeps(
  existingPs1: string | null,
  taskExists: boolean,
): {
  deps: WindowsDeps;
  writes: Array<{ path: string; content: string }>;
  ran: string[][];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const ran: string[][] = [];
  const deps: WindowsDeps = {
    readFile: () => existingPs1,
    writeFile: (p, content) => writes.push({ path: p, content }),
    mkdirp: () => {},
    taskExists: () => taskExists,
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, writes, ran };
}

const winArgs = {
  ps1Path: "C:\\Users\\u\\.humming\\autostart\\humming-autostart.ps1",
  ps1Spec: { hummingCommand: "humming" },
  taskName: "Humming Gateway Autostart",
  taskXml: "<Task/>",
};

describe("installWindowsAutostart", () => {
  it("writes ps1 and registers the task when neither exists", () => {
    const { deps, writes, ran } = fakeWinDeps(null, false);
    const report = installWindowsAutostart({ ...winArgs, deps });
    expect(report.kind).toBe("installed");
    expect(writes.some((w) => w.path === winArgs.ps1Path)).toBe(true);
    expect(ran.some((r) => r[0] === "schtasks.exe" && r.includes("/create"))).toBe(true);
  });

  it("is already-current when ps1 matches and task exists", () => {
    const current = renderAutostartPs1(winArgs.ps1Spec);
    const { deps, writes, ran } = fakeWinDeps(current, true);
    const report = installWindowsAutostart({ ...winArgs, deps });
    expect(report.kind).toBe("already-current");
    expect(writes).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });
});

function disableWinDeps(taskExists: boolean): { deps: WindowsDeps; ran: string[][] } {
  const ran: string[][] = [];
  const deps: WindowsDeps = {
    readFile: () => null,
    writeFile: () => {},
    mkdirp: () => {},
    taskExists: () => taskExists,
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, ran };
}

describe("disableWindowsAutostart", () => {
  it("disables an existing task", () => {
    const { deps, ran } = disableWinDeps(true);
    const report = disableWindowsAutostart({ taskName: "Humming Gateway Autostart", deps });
    expect(report.kind).toBe("disabled");
    expect(ran).toContainEqual([
      "schtasks.exe",
      "/change",
      "/tn",
      "Humming Gateway Autostart",
      "/disable",
    ]);
  });

  it("is already-disabled when the task is absent", () => {
    const { deps, ran } = disableWinDeps(false);
    const report = disableWindowsAutostart({ taskName: "Humming Gateway Autostart", deps });
    expect(report.kind).toBe("already-disabled");
    expect(ran).toHaveLength(0);
  });
});

function queryWinDeps(taskExists: boolean, queryStdout: string): { deps: WindowsDeps } {
  const deps: WindowsDeps = {
    readFile: () => null,
    writeFile: () => {},
    mkdirp: () => {},
    taskExists: () => taskExists,
    run: () => ({ status: 0, stdout: queryStdout, stderr: "" }),
  };
  return { deps };
}

describe("queryWindowsAutostart", () => {
  it("reports not-installed when the task is absent", () => {
    const { deps } = queryWinDeps(false, "");
    const status = queryWindowsAutostart({ taskName: "Humming Gateway Autostart", deps });
    expect(status.kind).toBe("not-installed");
  });

  it("reports enabled when the task state is Ready", () => {
    const { deps } = queryWinDeps(true, "  Scheduled Task State:      Enabled\r\n");
    const status = queryWindowsAutostart({ taskName: "Humming Gateway Autostart", deps });
    expect(status.kind).toBe("enabled");
  });

  it("reports installed-disabled when the task state is Disabled", () => {
    const { deps } = queryWinDeps(true, "  Scheduled Task State:      Disabled\r\n");
    const status = queryWindowsAutostart({ taskName: "Humming Gateway Autostart", deps });
    expect(status.kind).toBe("installed-disabled");
  });
});
