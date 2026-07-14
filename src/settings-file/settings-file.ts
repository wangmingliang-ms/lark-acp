import fs from "node:fs";
import path from "node:path";

const SETTINGS_FILE_MODE = 0o600;

/**
 * Invalid or unreadable settings content.
 */
export class SettingsFileFormatError extends Error {
  override readonly name = "SettingsFileFormatError";
}

/**
 * @throws {SettingsFileFormatError} when the file is unreadable, malformed,
 * or does not contain an object.
 */
export function readSettingsFileObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new SettingsFileFormatError(
      `failed to read settings file ${filePath}: ${errorMessage(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SettingsFileFormatError(
      `settings file ${filePath} is not valid JSON: ${errorMessage(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsFileFormatError(`settings file ${filePath} must contain a JSON object`);
  }
  return parsed;
}

export function readSettingsFileObjectTolerant(filePath: string): Record<string, unknown> {
  try {
    return readSettingsFileObject(filePath);
  } catch {
    return {};
  }
}

/** @throws {SettingsFileFormatError} when a present field is not an object. */
export function readSettingsObjectField(
  root: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const value = root[field];
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new SettingsFileFormatError(`settings file ${field} must be a JSON object`);
  }
  return value;
}

export function isSettingsFileReadable(filePath: string): boolean {
  try {
    readSettingsFileObject(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Atomically write private settings without exposing partial content. */
export function writeSettingsFileObject(
  filePath: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: SETTINGS_FILE_MODE,
  });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, SETTINGS_FILE_MODE);
  } catch {
    // Best effort: Windows and some filesystems ignore POSIX modes.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
