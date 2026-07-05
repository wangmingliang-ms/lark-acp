#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = path.resolve(process.env.LARK_ACP_HOME || path.join(os.homedir(), ".lark-acp"));
const templateDir = path.join(root, "templates", "home");

function readTemplate(name) {
  return fs.readFileSync(path.join(templateDir, name), "utf-8");
}

function writeIfMissing(name, content) {
  const target = path.join(homeDir, name);
  if (fs.existsSync(target)) return;
  fs.writeFileSync(target, content, "utf-8");
}

function renderGuide(template) {
  const settingsPath = path.join(homeDir, "settings.json");
  const sessionsPath = path.join(homeDir, "sessions.json");
  return template
    .replaceAll("{{SETTINGS_PATH}}", settingsPath)
    .replaceAll("{{SESSIONS_PATH}}", sessionsPath)
    .replaceAll("{{CONTROL_SOCKET_PATH}}", path.join(homeDir, "control.sock"))
    .replaceAll("{{SETTINGS_EXAMPLE_PATH}}", path.join(homeDir, "settings.back.json"))
    .replaceAll("{{SESSIONS_EXAMPLE_PATH}}", path.join(homeDir, "sessions.back.json"));
}

try {
  fs.mkdirSync(homeDir, { recursive: true });
  const guide = renderGuide(readTemplate("AGENTS.md"));
  writeIfMissing("AGENTS.md", guide);
  writeIfMissing("CLAUDE.md", guide);
  writeIfMissing("settings.back.json", readTemplate("settings.back.json"));
  writeIfMissing("sessions.back.json", readTemplate("sessions.back.json"));
} catch (err) {
  // npm postinstall should never make package installation fail just because
  // the user's home directory is read-only. The CLI also installs these files
  // on `lark-acp proxy/start`, so this hook is a best-effort convenience.
  console.warn(
    `[lark-acp] postinstall template setup skipped: ${err instanceof Error ? err.message : String(err)}`,
  );
}
