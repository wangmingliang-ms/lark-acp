import { describe, it, expect } from "vitest";
import {
  renderAutostartPs1,
  renderTaskXml,
  installWindowsAutostart,
  disableWindowsAutostart,
  enableWindowsAutostart,
  uninstallWindowsAutostart,
  queryWindowsAutostart,
  resolveWindowsUserId,
  type WindowsDeps,
} from "./windows-installer.js";

describe("resolveWindowsUserId", () => {
  it("prefers USERDOMAIN\\USERNAME over the DNS hostname", () => {
    const id = resolveWindowsUserId(
      { USERDOMAIN: "DESKTOP-ABC", USERNAME: "wangmi" },
      "desktop-abc.mshome.net",
    );
    expect(id).toBe("DESKTOP-ABC\\wangmi");
  });

  it("falls back to COMPUTERNAME when USERDOMAIN is absent", () => {
    const id = resolveWindowsUserId({ USERNAME: "wangmi", COMPUTERNAME: "WINBOX" }, "ignored");
    expect(id).toBe("WINBOX\\wangmi");
  });

  it("falls back to the injected hostname when no env domain is set", () => {
    const id = resolveWindowsUserId({ USERNAME: "wangmi" }, "HOSTFALLBACK");
    expect(id).toBe("HOSTFALLBACK\\wangmi");
  });

  it("throws when USERNAME is missing", () => {
    expect(() => resolveWindowsUserId({ COMPUTERNAME: "WINBOX" }, "host")).toThrow(/USERNAME/);
  });
});

describe("renderAutostartPs1", () => {
  it("starts the gateway and never adds an agent flag", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming" });
    expect(text).toContain("humming gateway start");
    // agent is resolved by `gateway start` at runtime, never baked in.
    expect(text).not.toContain("--agent");
  });
});

describe("renderTaskXml", () => {
  it("renders a LogonTrigger task (no BootTrigger) invoking pwsh with the ps1", () => {
    const xml = renderTaskXml({
      description: "Humming gateway autostart",
      pwshPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ps1Path: "C:\\Users\\u\\.humming\\autostart\\humming-autostart.ps1",
      userId: "MACHINE\\u",
    });
    expect(xml).toContain("<LogonTrigger>");
    // BootTrigger would force admin rights to register; we deliberately avoid it.
    expect(xml).not.toContain("<BootTrigger>");
    // Principal + LogonTrigger both scope to the same user (fires only on that logon).
    expect(xml.match(/<UserId>MACHINE\\u<\/UserId>/g)).toHaveLength(2);
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("pwsh.exe");
    expect(xml).toContain("humming-autostart.ps1");
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
    rm: () => {},
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
    rm: () => {},
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

function enableWinDeps(
  taskExists: boolean,
  queryStdout: string,
): { deps: WindowsDeps; ran: string[][] } {
  const ran: string[][] = [];
  const deps: WindowsDeps = {
    readFile: () => null,
    writeFile: () => {},
    mkdirp: () => {},
    rm: () => {},
    taskExists: () => taskExists,
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      if (args.includes("/query")) return { status: 0, stdout: queryStdout, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, ran };
}

const TASK = "Humming Gateway Autostart";
const PS1 = "C:\\Users\\u\\.humming\\autostart\\humming-autostart.ps1";

describe("enableWindowsAutostart", () => {
  it("enables an installed-but-disabled task", () => {
    const { deps, ran } = enableWinDeps(true, "  Scheduled Task State:      Disabled\r\n");
    const report = enableWindowsAutostart({ ps1Path: PS1, taskName: TASK, deps });
    expect(report.kind).toBe("enabled");
    expect(ran).toContainEqual(["schtasks.exe", "/change", "/tn", TASK, "/enable"]);
  });

  it("is not-installed when the task is absent", () => {
    const { deps, ran } = enableWinDeps(false, "");
    const report = enableWindowsAutostart({ ps1Path: PS1, taskName: TASK, deps });
    expect(report.kind).toBe("not-installed");
    expect(ran.some((r) => r.includes("/enable"))).toBe(false);
  });

  it("is already-current when the task is already enabled", () => {
    const { deps, ran } = enableWinDeps(true, "  Scheduled Task State:      Enabled\r\n");
    const report = enableWindowsAutostart({ ps1Path: PS1, taskName: TASK, deps });
    expect(report.kind).toBe("already-current");
    expect(ran.some((r) => r.includes("/enable"))).toBe(false);
  });
});

function uninstallWinDeps(
  taskExists: boolean,
  ps1Exists: boolean,
): { deps: WindowsDeps; ran: string[][]; removed: string[] } {
  const ran: string[][] = [];
  const removed: string[] = [];
  const deps: WindowsDeps = {
    readFile: () => (ps1Exists ? "ps1-content" : null),
    writeFile: () => {},
    mkdirp: () => {},
    rm: (p) => removed.push(p),
    taskExists: () => taskExists,
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, ran, removed };
}

describe("uninstallWindowsAutostart", () => {
  it("deletes the task and removes ps1 + xml files", () => {
    const { deps, ran, removed } = uninstallWinDeps(true, true);
    const report = uninstallWindowsAutostart({ ps1Path: PS1, taskName: TASK, deps });
    expect(report.kind).toBe("uninstalled");
    expect(ran).toContainEqual(["schtasks.exe", "/delete", "/tn", TASK, "/f"]);
    expect(removed).toContain(PS1);
    expect(removed).toContain(`${PS1}.task.xml`);
  });

  it("is already-uninstalled when neither task nor ps1 is present", () => {
    const { deps, ran, removed } = uninstallWinDeps(false, false);
    const report = uninstallWindowsAutostart({ ps1Path: PS1, taskName: TASK, deps });
    expect(report.kind).toBe("already-uninstalled");
    expect(ran).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });
});

function queryWinDeps(taskExists: boolean, queryStdout: string): { deps: WindowsDeps } {
  const deps: WindowsDeps = {
    readFile: () => null,
    writeFile: () => {},
    mkdirp: () => {},
    rm: () => {},
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
