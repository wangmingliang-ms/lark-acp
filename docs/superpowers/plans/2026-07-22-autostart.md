# Humming Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent `autostart` module that installs OS-native boot autostart for the Humming gateway — systemd user service on Linux, Task Scheduler boot task on Windows — invoked from `init`, `update`, and a new `humming autostart` command.

**Architecture:** A standalone `bin/autostart/` module. Pure content-generation functions (systemd unit text, PowerShell script, schtasks XML) are isolated and unit-tested directly. Side effects (fs writes, `systemctl`, `schtasks`) go through injected executor/fs interfaces so tests never touch the real system. A single `ensureAutostart(homeDir, deps)` orchestrator detects the platform, dispatches to the right installer, and returns a discriminated-union `AutostartReport`.

**Tech Stack:** TypeScript (strict, NodeNext ESM), vitest, `node:child_process` `spawnSync`, `node:fs`. Reuses `isUserSystemdAvailable()` and `gatewayUnitName()` from `bin/process-control.ts`.

---

## File Structure

- `bin/autostart/index.ts` — public façade: re-exports `ensureAutostart`, `AutostartReport`.
- `bin/autostart/autostart.ts` — orchestrator `ensureAutostart` + `detectAutostartTarget` + `AutostartReport` type + `AutostartDeps` injection interface.
- `bin/autostart/systemd-installer.ts` — Linux installer: `renderSystemdUnit` (pure) + `installSystemdAutostart`.
- `bin/autostart/windows-installer.ts` — Windows installer: `renderAutostartPs1` + `renderTaskXml` (pure) + `installWindowsAutostart`.
- `bin/autostart/autostart.test.ts` — dispatch + idempotency tests.
- `bin/autostart/systemd-installer.test.ts` — pure render + install-flow tests.
- `bin/autostart/windows-installer.test.ts` — pure render + install-flow tests.
- `bin/cli/commands/autostart.ts` — `registerAutostartCommand`.
- Modify `bin/cli/program.ts` — register the new command.
- Modify `bin/cli/commands/init.ts` — call `ensureAutostart` at end.
- Modify `bin/cli/commands/update.ts` — call `ensureAutostart` at end.

---

## Task 1: Shared types and dependency-injection surface

**Files:**
- Create: `bin/autostart/autostart.ts`
- Test: `bin/autostart/autostart.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// bin/autostart/autostart.test.ts
import { describe, it, expect } from "vitest";
import { detectAutostartTarget } from "./autostart.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/autostart.test.ts`
Expected: FAIL — cannot find module `./autostart.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bin/autostart/autostart.ts
/**
 * OS-native boot autostart for the Humming gateway. Linux → persistent
 * user-systemd unit; Windows → a boot-triggered Task Scheduler task.
 * Detection and side effects are injected so the logic is unit-testable.
 */

/** Which installer applies, or a human-readable reason none does. */
export type AutostartTarget = "systemd" | "windows-task" | { readonly unsupported: string };

/** Mechanism label carried in reports. */
export type AutostartMechanism = "systemd" | "windows-task";

/** Result of an `ensureAutostart` call. */
export type AutostartReport =
  | { readonly kind: "installed"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "already-current";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "skipped"; readonly reason: string };

/** Inputs to platform detection (injected for tests). */
export interface AutostartEnv {
  readonly platform: NodeJS.Platform;
  readonly systemdAvailable: boolean;
}

/**
 * Decide which autostart mechanism fits the current OS. WSL is treated as
 * ordinary Linux.
 */
export function detectAutostartTarget(env: AutostartEnv): AutostartTarget {
  if (env.platform === "win32") return "windows-task";
  if (env.platform === "linux") {
    if (env.systemdAvailable) return "systemd";
    return { unsupported: "linux without user systemd (systemctl --user unavailable)" };
  }
  return { unsupported: `unsupported platform: ${env.platform}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/autostart.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/autostart.ts bin/autostart/autostart.test.ts
git commit -m "feat(autostart): add platform detection and report types"
```

---

## Task 2: systemd unit renderer (pure)

**Files:**
- Create: `bin/autostart/systemd-installer.ts`
- Test: `bin/autostart/systemd-installer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// bin/autostart/systemd-installer.test.ts
import { describe, it, expect } from "vitest";
import { renderSystemdUnit } from "./systemd-installer.js";

describe("renderSystemdUnit", () => {
  it("renders a Type=simple unit with ExecStart and no agent flag", () => {
    const text = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      selfPath: "/opt/humming/dist/bin/humming.js",
      agent: null,
    });
    expect(text).toContain("Description=Humming gateway");
    expect(text).toContain("Type=simple");
    expect(text).toContain(
      "ExecStart=/usr/bin/node /opt/humming/dist/bin/humming.js gateway run",
    );
    expect(text).not.toContain("--agent");
    expect(text).toContain("WantedBy=default.target");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("appends the agent flag when provided", () => {
    const text = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      selfPath: "/opt/humming/dist/bin/humming.js",
      agent: "claude",
    });
    expect(text).toContain(
      "ExecStart=/usr/bin/node /opt/humming/dist/bin/humming.js gateway run --agent claude",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/systemd-installer.test.ts`
Expected: FAIL — cannot find module `./systemd-installer.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bin/autostart/systemd-installer.ts
/** Inputs for the persistent systemd user unit that boots the gateway. */
export interface SystemdUnitSpec {
  readonly nodePath: string;
  readonly selfPath: string;
  readonly agent: string | null;
}

/** Render the `.service` file text (pure). Trailing newline included. */
export function renderSystemdUnit(spec: SystemdUnitSpec): string {
  const agentSuffix = spec.agent !== null ? ` --agent ${spec.agent}` : "";
  const execStart = `${spec.nodePath} ${spec.selfPath} gateway run${agentSuffix}`;
  return (
    [
      "[Unit]",
      "Description=Humming gateway",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${execStart}`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\n") + "\n"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/systemd-installer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/systemd-installer.ts bin/autostart/systemd-installer.test.ts
git commit -m "feat(autostart): render systemd unit text"
```

---

## Task 3: systemd installer flow (injected fs + runner, idempotent)

**Files:**
- Modify: `bin/autostart/systemd-installer.ts`
- Test: `bin/autostart/systemd-installer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to bin/autostart/systemd-installer.test.ts
import { installSystemdAutostart, type SystemdDeps } from "./systemd-installer.js";

function fakeDeps(existing: string | null): {
  deps: SystemdDeps;
  writes: Array<{ path: string; content: string }>;
  ran: string[][];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const ran: string[][] = [];
  const deps: SystemdDeps = {
    readFile: (p) => (existing === null ? null : existing),
    writeFile: (p, content) => writes.push({ path: p, content }),
    mkdirp: () => {},
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, writes, ran };
}

const spec = {
  nodePath: "/usr/bin/node",
  selfPath: "/opt/humming/dist/bin/humming.js",
  agent: null,
};

describe("installSystemdAutostart", () => {
  it("writes the unit and enables it when absent", () => {
    const { deps, writes, ran } = fakeDeps(null);
    const report = installSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      user: "u",
      spec,
      deps,
    });
    expect(report.kind).toBe("installed");
    expect(writes).toHaveLength(1);
    expect(ran).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(ran).toContainEqual(["systemctl", "--user", "enable", "humming.service"]);
    expect(ran).toContainEqual(["loginctl", "enable-linger", "u"]);
  });

  it("is idempotent when content already matches", () => {
    const current = renderSystemdUnit(spec); // imported at top of file
    const { deps, writes } = fakeDeps(current);
    const report = installSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      user: "u",
      spec,
      deps,
    });
    expect(report.kind).toBe("already-current");
    expect(writes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/systemd-installer.test.ts`
Expected: FAIL — `installSystemdAutostart` / `SystemdDeps` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to bin/autostart/systemd-installer.ts
import type { AutostartReport } from "./autostart.js";

/** Result of a spawned command. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injected side effects for the systemd installer. */
export interface SystemdDeps {
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, content: string) => void;
  readonly mkdirp: (dir: string) => void;
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
}

/** Everything needed to install the persistent unit. */
export interface SystemdInstallArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly user: string;
  readonly spec: SystemdUnitSpec;
  readonly deps: SystemdDeps;
}

/**
 * Write the unit (only when changed), reload/enable it, and enable linger.
 * @throws {Error} when a systemctl/loginctl command exits non-zero.
 */
export function installSystemdAutostart(args: SystemdInstallArgs): AutostartReport {
  const desired = renderSystemdUnit(args.spec);
  const current = args.deps.readFile(args.unitPath);
  if (current === desired) {
    return { kind: "already-current", mechanism: "systemd", path: args.unitPath };
  }
  const dir = args.unitPath.slice(0, args.unitPath.lastIndexOf("/"));
  args.deps.mkdirp(dir);
  args.deps.writeFile(args.unitPath, desired);
  runOrThrow(args.deps, "systemctl", ["--user", "daemon-reload"]);
  runOrThrow(args.deps, "systemctl", ["--user", "enable", args.unitName]);
  runOrThrow(args.deps, "loginctl", ["enable-linger", args.user]);
  return { kind: "installed", mechanism: "systemd", path: args.unitPath };
}

function runOrThrow(deps: SystemdDeps, cmd: string, cmdArgs: readonly string[]): void {
  const result = deps.run(cmd, cmdArgs);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/systemd-installer.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/systemd-installer.ts bin/autostart/systemd-installer.test.ts
git commit -m "feat(autostart): idempotent systemd install flow"
```

---

## Task 4: Windows renderers (pure) — PowerShell script + task XML

**Files:**
- Create: `bin/autostart/windows-installer.ts`
- Test: `bin/autostart/windows-installer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// bin/autostart/windows-installer.test.ts
import { describe, it, expect } from "vitest";
import { renderAutostartPs1, renderTaskXml } from "./windows-installer.js";

describe("renderAutostartPs1", () => {
  it("starts the gateway with no agent flag by default", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming", agent: null });
    expect(text).toContain("humming gateway start");
    expect(text).not.toContain("--agent");
  });

  it("includes the agent flag when provided", () => {
    const text = renderAutostartPs1({ hummingCommand: "humming", agent: "claude" });
    expect(text).toContain("humming gateway start --agent claude");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/windows-installer.test.ts`
Expected: FAIL — cannot find module `./windows-installer.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bin/autostart/windows-installer.ts
/** Inputs for the PowerShell autostart script. */
export interface AutostartPs1Spec {
  readonly hummingCommand: string;
  readonly agent: string | null;
}

/** Render the `.ps1` body that starts the gateway (pure). */
export function renderAutostartPs1(spec: AutostartPs1Spec): string {
  const agentSuffix = spec.agent !== null ? ` --agent ${spec.agent}` : "";
  return `# Autogenerated by humming autostart. Do not edit.\n${spec.hummingCommand} gateway start${agentSuffix}\n`;
}

/** Inputs for the boot-triggered scheduled task XML. */
export interface TaskXmlSpec {
  readonly description: string;
  readonly pwshPath: string;
  readonly ps1Path: string;
  readonly userId: string;
}

/** Render schtasks-compatible task XML with a BootTrigger (pure). */
export function renderTaskXml(spec: TaskXmlSpec): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${spec.description}</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${spec.userId}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${spec.pwshPath}</Command>
      <Arguments>-NoProfile -WindowStyle Hidden -File "${spec.ps1Path}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/windows-installer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/windows-installer.ts bin/autostart/windows-installer.test.ts
git commit -m "feat(autostart): render Windows ps1 and scheduled task xml"
```

---

## Task 5: Windows installer flow (injected fs + runner, idempotent)

**Files:**
- Modify: `bin/autostart/windows-installer.ts`
- Test: `bin/autostart/windows-installer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to bin/autostart/windows-installer.test.ts
import { installWindowsAutostart, type WindowsDeps } from "./windows-installer.js";

function fakeWinDeps(existingPs1: string | null, taskExists: boolean): {
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
  ps1Spec: { hummingCommand: "humming", agent: null },
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
    const current = renderAutostartPs1(winArgs.ps1Spec); // imported at top of file
    const { deps, writes, ran } = fakeWinDeps(current, true);
    const report = installWindowsAutostart({ ...winArgs, deps });
    expect(report.kind).toBe("already-current");
    expect(writes).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/windows-installer.test.ts`
Expected: FAIL — `installWindowsAutostart` / `WindowsDeps` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to bin/autostart/windows-installer.ts
import type { AutostartReport } from "./autostart.js";
import type { RunResult } from "./systemd-installer.js";

/** Injected side effects for the Windows installer. */
export interface WindowsDeps {
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, content: string) => void;
  readonly mkdirp: (dir: string) => void;
  readonly taskExists: (taskName: string) => boolean;
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
}

/** Everything needed to install the Windows autostart task. */
export interface WindowsInstallArgs {
  readonly ps1Path: string;
  readonly ps1Spec: AutostartPs1Spec;
  readonly taskName: string;
  readonly taskXml: string;
  readonly deps: WindowsDeps;
}

/**
 * Write the ps1 (when changed) and (re)register the boot task via schtasks.
 * @throws {Error} when schtasks exits non-zero.
 */
export function installWindowsAutostart(args: WindowsInstallArgs): AutostartReport {
  const desiredPs1 = renderAutostartPs1(args.ps1Spec);
  const currentPs1 = args.deps.readFile(args.ps1Path);
  const ps1Current = currentPs1 === desiredPs1;
  const taskPresent = args.deps.taskExists(args.taskName);
  if (ps1Current && taskPresent) {
    return { kind: "already-current", mechanism: "windows-task", path: args.taskName };
  }
  if (!ps1Current) {
    const dir = args.ps1Path.slice(0, args.ps1Path.lastIndexOf("\\"));
    args.deps.mkdirp(dir);
    args.deps.writeFile(args.ps1Path, desiredPs1);
  }
  // schtasks reads the XML from a temp file path passed by the caller-side
  // orchestrator; here we (re)create by name using /xml.
  if (taskPresent) {
    runOrThrow(args.deps, "schtasks.exe", ["/delete", "/tn", args.taskName, "/f"]);
  }
  const xmlPath = `${args.ps1Path}.task.xml`;
  args.deps.writeFile(xmlPath, args.taskXml);
  runOrThrow(args.deps, "schtasks.exe", [
    "/create",
    "/tn",
    args.taskName,
    "/xml",
    xmlPath,
    "/f",
  ]);
  return { kind: "installed", mechanism: "windows-task", path: args.taskName };
}

function runOrThrow(deps: WindowsDeps, cmd: string, cmdArgs: readonly string[]): void {
  const result = deps.run(cmd, cmdArgs);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/windows-installer.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/windows-installer.ts bin/autostart/windows-installer.test.ts
git commit -m "feat(autostart): idempotent Windows scheduled-task install flow"
```

---

## Task 6: Orchestrator `ensureAutostart` + real deps wiring

**Files:**
- Modify: `bin/autostart/autostart.ts`
- Create: `bin/autostart/index.ts`
- Test: `bin/autostart/autostart.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to bin/autostart/autostart.test.ts
import { ensureAutostart, type AutostartRuntime } from "./autostart.js";

function baseRuntime(overrides: Partial<AutostartRuntime>): AutostartRuntime {
  return {
    env: { platform: "linux", systemdAvailable: true },
    installSystemd: () => ({ kind: "installed", mechanism: "systemd", path: "/unit" }),
    installWindows: () => ({ kind: "installed", mechanism: "windows-task", path: "task" }),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/autostart.test.ts`
Expected: FAIL — `ensureAutostart` / `AutostartRuntime` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to bin/autostart/autostart.ts

/**
 * Injected seams for `ensureAutostart`: platform inputs plus the two
 * platform installers (already bound to their real fs/runner deps by the
 * caller). Lets the dispatcher be tested without real side effects.
 */
export interface AutostartRuntime {
  readonly env: AutostartEnv;
  readonly installSystemd: () => AutostartReport;
  readonly installWindows: () => AutostartReport;
}

/** Detect the platform and run the matching installer, else skip. */
export function ensureAutostart(runtime: AutostartRuntime): AutostartReport {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.installSystemd();
  if (target === "windows-task") return runtime.installWindows();
  return { kind: "skipped", reason: target.unsupported };
}
```

```ts
// bin/autostart/index.ts
export { ensureAutostart, detectAutostartTarget } from "./autostart.js";
export type {
  AutostartReport,
  AutostartMechanism,
  AutostartRuntime,
  AutostartEnv,
} from "./autostart.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/autostart.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add bin/autostart/autostart.ts bin/autostart/index.ts bin/autostart/autostart.test.ts
git commit -m "feat(autostart): orchestrator dispatch with injected installers"
```

---

## Task 7: Real-deps factory — bind installers to fs/child_process/settings

**Files:**
- Create: `bin/autostart/runtime.ts`
- Test: `bin/autostart/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// bin/autostart/runtime.test.ts
import { describe, it, expect } from "vitest";
import { resolveAgentFlag } from "./runtime.js";

describe("resolveAgentFlag", () => {
  it("returns runtime.agent when present", () => {
    expect(resolveAgentFlag({ runtime: { agent: "claude" } })).toBe("claude");
  });

  it("returns null when runtime.agent is absent", () => {
    expect(resolveAgentFlag({ runtime: {} })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/autostart/runtime.test.ts`
Expected: FAIL — cannot find module `./runtime.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bin/autostart/runtime.ts
/**
 * Wires the pure autostart logic to real side effects: filesystem, spawnSync,
 * settings.json, and process-control's systemd probes. This is the only file
 * in the module that touches the OS directly, so it stays thin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { isUserSystemdAvailable, gatewayUnitName } from "../process-control.js";
import { readConfigFile } from "../cli/config/load.js";
import {
  installSystemdAutostart,
  type RunResult,
  type SystemdDeps,
} from "./systemd-installer.js";
import { installWindowsAutostart, renderTaskXml, type WindowsDeps } from "./windows-installer.js";
import { ensureAutostart, type AutostartReport, type AutostartRuntime } from "./autostart.js";

/** Minimal shape read from settings for the agent default. */
export interface AgentSettingsView {
  readonly runtime: { readonly agent?: string };
}

/** The `--agent` default: settings `runtime.agent`, else null. */
export function resolveAgentFlag(settings: AgentSettingsView): string | null {
  return settings.runtime.agent ?? null;
}

function realRun(cmd: string, args: readonly string[]): RunResult {
  const r = spawnSync(cmd, [...args], { encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

const fsDeps = {
  readFile: readFileOrNull,
  writeFile: (p: string, content: string) => fs.writeFileSync(p, content, "utf-8"),
  mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
  run: realRun,
};

const WINDOWS_TASK_NAME = "Humming Gateway Autostart";

/**
 * Build an {@link AutostartRuntime} bound to the real OS for the given home.
 * @throws {Error} propagated from installers when systemctl/schtasks fails.
 */
export function buildAutostartRuntime(homeDir: string, selfPath: string): AutostartRuntime {
  const settings = readConfigFile(path.join(homeDir, "settings.json"));
  const agent = resolveAgentFlag(settings);
  return {
    env: { platform: process.platform, systemdAvailable: isUserSystemdAvailable() },
    installSystemd: () => {
      const unitName = gatewayUnitName(homeDir);
      const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unitName);
      const systemdDeps: SystemdDeps = fsDeps;
      return installSystemdAutostart({
        unitPath,
        unitName,
        user: os.userInfo().username,
        spec: { nodePath: process.execPath, selfPath, agent },
        deps: systemdDeps,
      });
    },
    installWindows: () => {
      const ps1Path = path.join(homeDir, "autostart", "humming-autostart.ps1");
      const pwshPath = "pwsh.exe";
      const userId = `${os.hostname()}\\${os.userInfo().username}`;
      const taskXml = renderTaskXml({
        description: "Humming gateway autostart",
        pwshPath,
        ps1Path,
        userId,
      });
      const winDeps: WindowsDeps = {
        ...fsDeps,
        taskExists: (name) =>
          realRun("schtasks.exe", ["/query", "/tn", name]).status === 0,
      };
      return installWindowsAutostart({
        ps1Path,
        ps1Spec: { hummingCommand: "humming", agent },
        taskName: WINDOWS_TASK_NAME,
        taskXml,
        deps: winDeps,
      });
    },
  };
}

/** Convenience: build the real runtime and run the dispatcher. */
export function ensureAutostartForHome(homeDir: string, selfPath: string): AutostartReport {
  return ensureAutostart(buildAutostartRuntime(homeDir, selfPath));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/autostart/runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify whole module typechecks**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add bin/autostart/runtime.ts bin/autostart/runtime.test.ts
git commit -m "feat(autostart): bind installers to real fs, spawnSync, and settings"
```

---

## Task 8: `humming autostart` CLI command

**Files:**
- Create: `bin/cli/commands/autostart.ts`
- Modify: `bin/cli/program.ts` (imports at top; register near line 43)
- Test: `bin/humming-autostart-command.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// bin/humming-autostart-command.test.ts
import { describe, it, expect } from "vitest";
import { formatAutostartReport } from "./cli/commands/autostart.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/humming-autostart-command.test.ts`
Expected: FAIL — cannot find module `./cli/commands/autostart.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bin/cli/commands/autostart.ts
/**
 * `humming autostart` — install (idempotently) OS-native boot autostart for
 * the gateway. Wraps the autostart module; also invoked by init/update.
 */
import process from "node:process";
import { Command } from "commander";
import { resolveHomeDir } from "../config/load.js";
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import type { AutostartReport } from "../../autostart/index.js";
import type { GlobalOptions } from "../context.js";

/** Human-readable one-liner for a report. */
export function formatAutostartReport(report: AutostartReport): string {
  switch (report.kind) {
    case "installed":
      return `autostart installed (${report.mechanism}) at ${report.path}`;
    case "already-current":
      return `autostart already current (${report.mechanism}) at ${report.path}`;
    case "skipped":
      return `autostart skipped: ${report.reason}`;
  }
}

export interface RegisterAutostartOptions {
  readonly selfPath: string;
}

export function registerAutostartCommand(
  program: Command,
  opts: RegisterAutostartOptions,
): void {
  program
    .command("autostart")
    .description("install OS-native boot autostart for the gateway")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = ensureAutostartForHome(homeDir, opts.selfPath);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });
}
```

Modify `bin/cli/program.ts`:
- Add import after line 12:
```ts
import { registerAutostartCommand } from "./commands/autostart.js";
```
- Add registration after line 43 (`registerUpdateCommand(program);`):
```ts
  registerAutostartCommand(program, { selfPath: opts.selfPath });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/humming-autostart-command.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc exit 0.

- [ ] **Step 5: Smoke-test the command end to end**

Run: `npm run build && node dist/bin/humming.js autostart`
Expected: prints one of `autostart installed (systemd) ...` / `already current` / `skipped: ...` with no crash.

- [ ] **Step 6: Commit**

```bash
git add bin/cli/commands/autostart.ts bin/cli/program.ts bin/humming-autostart-command.test.ts
git commit -m "feat(autostart): add humming autostart command"
```

---

## Task 9: Wire autostart into `init` and `update`

**Files:**
- Modify: `bin/cli/commands/init.ts`
- Modify: `bin/cli/commands/update.ts`
- Test: reuse existing `bin/humming.test.ts` behavior; add a focused test in `bin/humming-autostart-command.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to bin/humming-autostart-command.test.ts
import { describe as describe2, it as it2, expect as expect2 } from "vitest";

// init/update are thin wrappers; assert they export a runInit/runUpdate that
// accepts a selfPath so autostart can be triggered. This guards the wiring
// contract without spawning real installers.
import { runInit } from "./cli/commands/init.js";
import { runUpdate } from "./cli/commands/update.js";

describe2("init/update autostart wiring contract", () => {
  it2("runInit accepts a selfPath argument", () => {
    expect2(runInit.length).toBeGreaterThanOrEqual(2);
  });
  it2("runUpdate is a function", () => {
    expect2(typeof runUpdate).toBe("function");
  });
});
```

Note: `runInit` currently takes only `globals`. This test forces adding a `selfPath` parameter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bin/humming-autostart-command.test.ts`
Expected: FAIL — `runInit.length` is 1 (< 2).

- [ ] **Step 3: Write minimal implementation**

Modify `bin/cli/commands/init.ts`:
- Update the import block:
```ts
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import { formatAutostartReport } from "./autostart.js";
```
- Change `registerInitCommand` to pass `selfPath`. Update signature and action:
```ts
export function registerInitCommand(program: Command, opts: { readonly selfPath: string }): void {
  program
    .command("init")
    .description("seed ~/.humming guide/example files (no live settings/sessions)")
    .action(function (this: Command) {
      runInit(this.optsWithGlobals<GlobalOptions>(), opts.selfPath);
    });
}
```
- Change `runInit` to accept `selfPath` and call autostart at the end (after the existing stdout block):
```ts
export function runInit(globals: GlobalOptions, selfPath: string): void {
  const { homeDir } = installHomeBootstrap(globals, true);
  process.stdout.write(
    [
      /* ...existing lines unchanged... */
    ].join("\n"),
  );
  const report = ensureAutostartForHome(homeDir, selfPath);
  process.stdout.write(`${formatAutostartReport(report)}\n`);
}
```

Modify `bin/cli/program.ts` registration for init to pass selfPath:
```ts
  registerInitCommand(program, { selfPath: opts.selfPath });
```

Modify `bin/cli/commands/update.ts`:
- Add imports:
```ts
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import { formatAutostartReport } from "./autostart.js";
```
- In `registerUpdateCommand`, capture selfPath the same way (add `opts: { readonly selfPath: string }` param and pass into `runUpdate`), and at the very end of `runUpdate` (after `restartBridgeAfterUpdate(homeDir)`), add:
```ts
  const report = ensureAutostartForHome(homeDir, selfPath);
  process.stdout.write(`${formatAutostartReport(report)}\n`);
```
- Update `runUpdate` signature to `runUpdate(globals: GlobalOptions, selfPath: string)`.
- Update program.ts: `registerUpdateCommand(program, { selfPath: opts.selfPath });`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bin/humming-autostart-command.test.ts && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green (existing init/update tests updated as needed for the new arg — fix any that call `runInit(globals)` to `runInit(globals, "/x")`).

- [ ] **Step 6: Commit**

```bash
git add bin/cli/commands/init.ts bin/cli/commands/update.ts bin/cli/program.ts bin/humming-autostart-command.test.ts
git commit -m "feat(autostart): trigger autostart install from init and update"
```

---

## Task 10: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (document `humming autostart`)
- Modify: `docs/cli-command-model-SPEC.md` (add autostart to command tree)

- [ ] **Step 1: Full gate**

Run: `npx tsc --noEmit && npx vitest run && npx prettier --check bin/autostart`
Expected: tsc 0, all tests pass, prettier clean on new files.

- [ ] **Step 2: Manual E2E on this Linux box**

Run:
```bash
npm run build
node dist/bin/humming.js autostart
ls ~/.config/systemd/user/ | grep -i humming   # unit file present
node dist/bin/humming.js autostart   # second run
```
Expected: first run `installed (systemd)`, second run `already current (systemd)`, and a `*.service` unit listed for humming.

- [ ] **Step 3: Update docs**

Add to `CLAUDE.md` under the humming operations section:
```md
- `humming autostart`：为当前 OS 安装开机自启（Linux → systemd user service + linger；Windows → Task Scheduler 开机任务）。幂等；init/update 也会自动调用。
```
Add `autostart` to the command tree listing in `docs/cli-command-model-SPEC.md`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/cli-command-model-SPEC.md
git commit -m "docs(autostart): document humming autostart command"
```
