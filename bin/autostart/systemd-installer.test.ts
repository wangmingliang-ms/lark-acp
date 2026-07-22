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
    expect(text).toContain("ExecStart=/usr/bin/node /opt/humming/dist/bin/humming.js gateway run");
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
