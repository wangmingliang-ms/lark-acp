import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME_TEMPLATE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "settings.back.json",
  "sessions.back.json",
] as const;

export interface HomeTemplatePaths {
  readonly settingsPath: string;
  readonly sessionsPath: string;
  readonly controlSocketPath: string | null;
}

export interface InstallHomeTemplatesOptions extends HomeTemplatePaths {
  readonly homeDir: string;
  readonly overwriteDocs?: boolean;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR_CANDIDATES = [
  path.resolve(MODULE_DIR, "../templates/home"),
  path.resolve(MODULE_DIR, "../../templates/home"),
  path.resolve(MODULE_DIR, "../../../templates/home"),
];

export function installHomeTemplates(opts: InstallHomeTemplatesOptions): void {
  fs.mkdirSync(opts.homeDir, { recursive: true });
  const agents = renderTemplate(readTemplate("AGENTS.md"), opts);
  writeTemplate(path.join(opts.homeDir, "AGENTS.md"), agents, opts.overwriteDocs ?? false);
  writeTemplate(path.join(opts.homeDir, "CLAUDE.md"), agents, opts.overwriteDocs ?? false);
  writeTemplate(
    path.join(opts.homeDir, "settings.back.json"),
    readTemplate("settings.back.json"),
    false,
  );
  writeTemplate(
    path.join(opts.homeDir, "sessions.back.json"),
    readTemplate("sessions.back.json"),
    false,
  );
}

function readTemplate(name: (typeof HOME_TEMPLATE_NAMES)[number]): string {
  for (const dir of TEMPLATE_DIR_CANDIDATES) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
  }
  throw new Error(`lark-acp template ${name} not found in: ${TEMPLATE_DIR_CANDIDATES.join(", ")}`);
}

function writeTemplate(filePath: string, content: string, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, content, "utf-8");
}

function renderTemplate(template: string, opts: HomeTemplatePaths): string {
  return template
    .replaceAll("{{SETTINGS_PATH}}", opts.settingsPath)
    .replaceAll("{{SESSIONS_PATH}}", opts.sessionsPath)
    .replaceAll("{{CONTROL_SOCKET_PATH}}", opts.controlSocketPath ?? "(not configured)")
    .replaceAll(
      "{{SETTINGS_EXAMPLE_PATH}}",
      path.join(path.dirname(opts.settingsPath), "settings.back.json"),
    )
    .replaceAll(
      "{{SESSIONS_EXAMPLE_PATH}}",
      path.join(path.dirname(opts.sessionsPath), "sessions.back.json"),
    );
}
