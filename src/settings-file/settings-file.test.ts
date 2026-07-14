import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSettingsFileReadable,
  readSettingsFileObject,
  readSettingsFileObjectTolerant,
  readSettingsObjectField,
  SettingsFileFormatError,
  writeSettingsFileObject,
} from "./settings-file.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-settings-file-"));
  settingsPath = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readSettingsFileObject", () => {
  it("returns {} when the file does not exist", () => {
    expect(readSettingsFileObject(settingsPath)).toEqual({});
  });

  it("parses an existing JSON object", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ credentials: { appId: "cli_x" } }));
    expect(readSettingsFileObject(settingsPath)).toEqual({ credentials: { appId: "cli_x" } });
  });

  it("throws SettingsFileFormatError on malformed JSON", () => {
    fs.writeFileSync(settingsPath, "{ not json");
    expect(() => readSettingsFileObject(settingsPath)).toThrowError(SettingsFileFormatError);
    expect(() => readSettingsFileObject(settingsPath)).toThrowError(/not valid JSON/);
  });

  it("throws SettingsFileFormatError when the top-level value is not an object", () => {
    fs.writeFileSync(settingsPath, "[1,2,3]");
    expect(() => readSettingsFileObject(settingsPath)).toThrowError(/must contain a JSON object/);
  });
});

describe("readSettingsFileObjectTolerant", () => {
  it("returns {} instead of throwing on malformed JSON", () => {
    fs.writeFileSync(settingsPath, "{ half written");
    expect(readSettingsFileObjectTolerant(settingsPath)).toEqual({});
  });

  it("returns {} instead of throwing on a non-object top level", () => {
    fs.writeFileSync(settingsPath, "[1,2,3]");
    expect(readSettingsFileObjectTolerant(settingsPath)).toEqual({});
  });

  it("parses cleanly otherwise", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ runtime: { agent: "claude" } }));
    expect(readSettingsFileObjectTolerant(settingsPath)).toEqual({ runtime: { agent: "claude" } });
  });
});

describe("readSettingsObjectField", () => {
  it("returns {} when the field is absent", () => {
    expect(readSettingsObjectField({}, "runtime")).toEqual({});
  });

  it("returns the nested object when present", () => {
    expect(readSettingsObjectField({ runtime: { agent: "claude" } }, "runtime")).toEqual({
      agent: "claude",
    });
  });

  it("throws SettingsFileFormatError when the field is not an object", () => {
    expect(() => readSettingsObjectField({ runtime: "nope" }, "runtime")).toThrowError(
      SettingsFileFormatError,
    );
  });
});

describe("isSettingsFileReadable", () => {
  it("is true when the file is absent", () => {
    expect(isSettingsFileReadable(settingsPath)).toBe(true);
  });

  it("is true for a well-formed object", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({}));
    expect(isSettingsFileReadable(settingsPath)).toBe(true);
  });

  it("is false for a half-written file", () => {
    fs.writeFileSync(settingsPath, "{ half written");
    expect(isSettingsFileReadable(settingsPath)).toBe(false);
  });
});

describe("writeSettingsFileObject", () => {
  it("writes mode 0600 and JSON content that round-trips", () => {
    writeSettingsFileObject(settingsPath, { credentials: { appId: "cli_x" } });
    const mode = fs.statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({
      credentials: { appId: "cli_x" },
    });
  });

  it("overwrites atomically via temp file + rename, leaving no stray temp files", () => {
    writeSettingsFileObject(settingsPath, { a: 1 });
    writeSettingsFileObject(settingsPath, { a: 2 });
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["settings.json"]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ a: 2 });
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(dir, "nested", "settings.json");
    writeSettingsFileObject(nested, { a: 1 });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
