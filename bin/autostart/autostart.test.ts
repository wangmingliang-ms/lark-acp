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
