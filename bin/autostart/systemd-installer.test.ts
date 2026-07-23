import { describe, it, expect } from "vitest";
import {
  renderSystemdUnit,
  installSystemdAutostart,
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

function fakeDeps(existing: string | null): {
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

  it("is idempotent when content already matches", () => {
    const current = renderSystemdUnit(installSpec);
    const { deps, writes } = fakeDeps(current);
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
});
