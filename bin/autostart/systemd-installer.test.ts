import { describe, it, expect } from "vitest";
import {
  renderSystemdUnit,
  installSystemdAutostart,
  disableSystemdAutostart,
  querySystemdAutostart,
  type SystemdDeps,
} from "./systemd-installer.js";

describe("renderSystemdUnit", () => {
  it("renders a Type=simple unit with ExecStart and never an agent flag", () => {
    const text = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      selfPath: "/opt/humming/dist/bin/humming.js",
    });
    expect(text).toContain("Description=Humming gateway");
    expect(text).toContain("Type=simple");
    expect(text).toContain("ExecStart=/usr/bin/node /opt/humming/dist/bin/humming.js gateway run");
    // agent is resolved by `gateway run` at runtime, never baked into the unit.
    expect(text).not.toContain("--agent");
    expect(text).toContain("WantedBy=default.target");
    expect(text.endsWith("\n")).toBe(true);
  });
});

function fakeDeps(
  existing: string | null,
  isEnabled = "",
): {
  deps: SystemdDeps;
  writes: Array<{ path: string; content: string }>;
  ran: string[][];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const ran: string[][] = [];
  const deps: SystemdDeps = {
    readFile: () => existing,
    writeFile: (p, content) => writes.push({ path: p, content }),
    mkdirp: () => {},
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      if (args.includes("is-enabled")) return { status: 0, stdout: isEnabled, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, writes, ran };
}

const installSpec = {
  nodePath: "/usr/bin/node",
  selfPath: "/opt/humming/dist/bin/humming.js",
};

describe("installSystemdAutostart", () => {
  it("writes the unit and enables it when absent", () => {
    const { deps, writes, ran } = fakeDeps(null);
    const report = installSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      user: "u",
      spec: installSpec,
      deps,
    });
    expect(report.kind).toBe("installed");
    expect(writes).toHaveLength(1);
    expect(ran).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(ran).toContainEqual(["systemctl", "--user", "enable", "humming.service"]);
    expect(ran).toContainEqual(["loginctl", "enable-linger", "u"]);
  });

  it("is idempotent when content already matches and unit is enabled", () => {
    const current = renderSystemdUnit(installSpec);
    const { deps, writes } = fakeDeps(current, "enabled");
    const report = installSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      user: "u",
      spec: installSpec,
      deps,
    });
    expect(report.kind).toBe("already-current");
    expect(writes).toHaveLength(0);
  });

  it("re-enables when content matches but the unit is disabled", () => {
    const current = renderSystemdUnit(installSpec);
    // fakeDeps reports is-enabled as "" (not "enabled"), i.e. disabled.
    const { deps, writes, ran } = fakeDeps(current);
    const report = installSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      user: "u",
      spec: installSpec,
      deps,
    });
    expect(report.kind).toBe("installed");
    expect(writes).toHaveLength(0); // file unchanged
    expect(ran).toContainEqual(["systemctl", "--user", "enable", "humming.service"]);
  });
});

function disableDeps(
  fileExists: boolean,
  isEnabled: string,
): { deps: SystemdDeps; ran: string[][] } {
  const ran: string[][] = [];
  const deps: SystemdDeps = {
    readFile: () => (fileExists ? "unit-content" : null),
    writeFile: () => {},
    mkdirp: () => {},
    run: (cmd, args) => {
      ran.push([cmd, ...args]);
      if (args.includes("is-enabled")) return { status: 0, stdout: isEnabled, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, ran };
}

describe("disableSystemdAutostart", () => {
  it("disables an enabled unit and keeps the file", () => {
    const { deps, ran } = disableDeps(true, "enabled");
    const report = disableSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(report.kind).toBe("disabled");
    expect(ran).toContainEqual(["systemctl", "--user", "disable", "humming.service"]);
  });

  it("is already-disabled when the unit file is absent", () => {
    const { deps, ran } = disableDeps(false, "enabled");
    const report = disableSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(report.kind).toBe("already-disabled");
    expect(ran).toHaveLength(0);
  });

  it("is already-disabled when the unit is not enabled", () => {
    const { deps, ran } = disableDeps(true, "disabled");
    const report = disableSystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(report.kind).toBe("already-disabled");
    expect(ran.some((r) => r.includes("disable"))).toBe(false);
  });
});

describe("querySystemdAutostart", () => {
  it("reports not-installed when the unit file is absent", () => {
    const { deps } = disableDeps(false, "enabled");
    const status = querySystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(status.kind).toBe("not-installed");
  });

  it("reports enabled when the unit is present and enabled", () => {
    const { deps } = disableDeps(true, "enabled");
    const status = querySystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(status.kind).toBe("enabled");
  });

  it("reports installed-disabled when present but not enabled", () => {
    const { deps } = disableDeps(true, "disabled");
    const status = querySystemdAutostart({
      unitPath: "/home/u/.config/systemd/user/humming.service",
      unitName: "humming.service",
      deps,
    });
    expect(status.kind).toBe("installed-disabled");
  });
});
