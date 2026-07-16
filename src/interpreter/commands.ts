/**
 * Slash command definitions and the sole command registry.
 *
 * Each registered command owns matching/parsing, execution, and help. The
 * interpreter and Bridge both delegate to this controller instead of keeping
 * parallel parser and dispatch tables.
 */

export type ProfileCommandName = "agent" | "model" | "mode" | "permission";
export type ProfilePermissionMode = "alwaysAsk" | "alwaysAllow" | "alwaysDeny";

export type LarkCommand =
  | { readonly kind: "cancel" }
  | { readonly kind: "new" }
  | { readonly kind: "restart" }
  | { readonly kind: "help" }
  | { readonly kind: "capabilities"; readonly agent: string | null }
  | { readonly kind: "bind"; readonly cwd: string; readonly agent: string | null }
  | { readonly kind: "bind-usage" }
  | { readonly kind: "unbind" }
  | { readonly kind: "where" }
  | { readonly kind: "set-agent"; readonly agent: string }
  | { readonly kind: "list-agents" }
  | { readonly kind: "set-model"; readonly model: string | "auto" }
  | { readonly kind: "list-models" }
  | { readonly kind: "set-mode"; readonly mode: string }
  | { readonly kind: "list-modes" }
  | { readonly kind: "set-permission"; readonly permissionMode: ProfilePermissionMode }
  | { readonly kind: "list-permissions" }
  | { readonly kind: "profile" };

export type SlashCommandContext = {
  cancel(): Promise<void>;
  newSession(): Promise<void>;
  restart(): Promise<void>;
  help(): Promise<void>;
  capabilities(agent: string | null): Promise<void>;
  bind(cwd: string, agent: string | null): Promise<void>;
  bindUsage(): Promise<void>;
  unbind(): Promise<void>;
  where(): Promise<void>;
  setAgent(agent: string): Promise<void>;
  listAgents(): Promise<void>;
  setModel(model: string | "auto"): Promise<void>;
  listModels(): Promise<void>;
  setMode(mode: string): Promise<void>;
  listModes(): Promise<void>;
  setPermission(permissionMode: ProfilePermissionMode): Promise<void>;
  listPermissions(): Promise<void>;
  profile(): Promise<void>;
};

export type CommandHelpEntry = {
  readonly syntax: string;
  readonly aliases?: readonly string[];
  readonly description: string;
};

export type CommandHelpGroup = {
  readonly title: string;
  readonly entries: readonly CommandHelpEntry[];
};

type CommandGroup = "Discovery" | "Repo / session";

export type SlashCommand = {
  readonly name: string;
  readonly tokens: readonly string[];
  readonly group: CommandGroup;
  readonly help: readonly CommandHelpEntry[];
  parse(input: string): LarkCommand | null;
  handle(context: SlashCommandContext, command: LarkCommand): Promise<void>;
};

export type SlashCommandInvocation = {
  readonly owner: SlashCommand;
  readonly command: LarkCommand;
};

const PROFILE_PERMISSION_MODES = ["alwaysAsk", "alwaysAllow", "alwaysDeny"] as const;

function defineExactCommand(options: {
  readonly name: string;
  readonly tokens: readonly string[];
  readonly kind: "cancel" | "new" | "restart" | "help" | "unbind" | "where";
  readonly group: CommandGroup;
  readonly help: readonly CommandHelpEntry[];
  readonly handle: (context: SlashCommandContext) => Promise<void>;
}): SlashCommand {
  return {
    name: options.name,
    tokens: options.tokens,
    group: options.group,
    help: options.help,
    parse: (input) => (tokenMatches(options.tokens, input) ? { kind: options.kind } : null),
    handle: async (context) => options.handle(context),
  };
}

const helpCommand = defineExactCommand({
  name: "help",
  tokens: ["/help", "/commands"],
  kind: "help",
  group: "Discovery",
  help: [
    {
      syntax: "/help",
      aliases: ["/commands"],
      description: "列出所有 Humming slash commands",
    },
  ],
  handle: (context) => context.help(),
});

const capabilitiesCommand: SlashCommand = {
  name: "capabilities",
  tokens: ["/capabilities"],
  group: "Discovery",
  help: [
    {
      syntax: "/capabilities",
      description: "列出当前有效 Agent 支持的 model / mode / config / permission controls",
    },
    {
      syntax: "/capabilities <agent>",
      description: "probe 指定 Agent 的 capabilities，只查询不切换",
    },
  ],
  parse(input) {
    const rest = stripLeadingToken(input, this.tokens[0]);
    if (rest === null) return null;
    if (rest.length === 0) return { kind: "capabilities", agent: null };
    if (/\s/.test(rest)) return null;
    return { kind: "capabilities", agent: rest };
  },
  async handle(context, command) {
    if (command.kind !== "capabilities") return rejectWrongCommand(this.name, command);
    await context.capabilities(command.agent);
  },
};

const agentCommand: SlashCommand = {
  name: "agent",
  tokens: ["/agent"],
  group: "Discovery",
  help: [
    { syntax: "/agent", description: "列出可用 Agent" },
    {
      syntax: "/agent <agent>",
      description: "切换当前 topic 的 Agent；已开始 topic 会先 warning，确认后才 probe/切换",
    },
  ],
  parse(input) {
    const value = parseOptionalSingleArgument(input, this.tokens[0]);
    if (value === null) return null;
    return value === "" ? { kind: "list-agents" } : { kind: "set-agent", agent: value };
  },
  async handle(context, command) {
    if (command.kind === "list-agents") return context.listAgents();
    if (command.kind === "set-agent") return context.setAgent(command.agent);
    return rejectWrongCommand(this.name, command);
  },
};

const modelCommand: SlashCommand = {
  name: "model",
  tokens: ["/model"],
  group: "Discovery",
  help: [
    { syntax: "/model", description: "通过 ACP capabilities 列出当前 Agent 可用 Models" },
    { syntax: "/model <model-id>", description: "设置当前 topic 的 Model" },
    {
      syntax: "/model auto",
      description: "清除显式 model override，使用 Agent 默认/自动模型",
    },
  ],
  parse(input) {
    const value = parseOptionalSingleArgument(input, this.tokens[0]);
    if (value === null) return null;
    if (value === "") return { kind: "list-models" };
    return { kind: "set-model", model: value.toLowerCase() === "auto" ? "auto" : value };
  },
  async handle(context, command) {
    if (command.kind === "list-models") return context.listModels();
    if (command.kind === "set-model") return context.setModel(command.model);
    return rejectWrongCommand(this.name, command);
  },
};

const modeCommand: SlashCommand = {
  name: "mode",
  tokens: ["/mode"],
  group: "Discovery",
  help: [
    { syntax: "/mode", description: "通过 ACP capabilities 列出当前 Agent 可用 Modes" },
    { syntax: "/mode <mode-id>", description: "设置当前 topic 的 Mode" },
  ],
  parse(input) {
    const value = parseOptionalSingleArgument(input, this.tokens[0]);
    if (value === null) return null;
    return value === "" ? { kind: "list-modes" } : { kind: "set-mode", mode: value };
  },
  async handle(context, command) {
    if (command.kind === "list-modes") return context.listModes();
    if (command.kind === "set-mode") return context.setMode(command.mode);
    return rejectWrongCommand(this.name, command);
  },
};

const permissionCommand: SlashCommand = {
  name: "permission",
  tokens: ["/permission"],
  group: "Discovery",
  help: [
    { syntax: "/permission", description: "列出 Humming approval 策略" },
    {
      syntax: "/permission <alwaysAsk|alwaysAllow|alwaysDeny>",
      description: "设置 Humming approval 策略",
    },
  ],
  parse(input) {
    const value = parseOptionalSingleArgument(input, this.tokens[0]);
    if (value === null) return null;
    if (value === "") return { kind: "list-permissions" };
    const permissionMode =
      PROFILE_PERMISSION_MODES.find((mode) => mode.toLowerCase() === value.toLowerCase()) ?? null;
    return permissionMode === null ? null : { kind: "set-permission", permissionMode };
  },
  async handle(context, command) {
    if (command.kind === "list-permissions") return context.listPermissions();
    if (command.kind === "set-permission") return context.setPermission(command.permissionMode);
    return rejectWrongCommand(this.name, command);
  },
};

const profileCommand: SlashCommand = {
  name: "profile",
  tokens: ["/profile"],
  group: "Discovery",
  help: [{ syntax: "/profile", description: "查看当前 topic profile" }],
  parse(input) {
    return stripLeadingToken(input, this.tokens[0]) === "" ? { kind: "profile" } : null;
  },
  async handle(context, command) {
    if (command.kind !== "profile") return rejectWrongCommand(this.name, command);
    await context.profile();
  },
};

const bindCommand: SlashCommand = {
  name: "bind",
  tokens: ["/bind"],
  group: "Repo / session",
  help: [{ syntax: "/bind <路径>", description: "绑定当前 chat 到 repo" }],
  parse(input) {
    const rest = stripLeadingToken(input, this.tokens[0]);
    if (rest === null) return null;
    if (rest.length === 0) return { kind: "bind-usage" };
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) return { kind: "bind", cwd: rest, agent: null };
    const cwd = rest.slice(0, firstSpace);
    const agent = rest.slice(firstSpace + 1).trim();
    return { kind: "bind", cwd, agent: agent.length > 0 ? agent : null };
  },
  async handle(context, command) {
    if (command.kind === "bind-usage") return context.bindUsage();
    if (command.kind === "bind") return context.bind(command.cwd, command.agent);
    return rejectWrongCommand(this.name, command);
  },
};

const whereCommand = defineExactCommand({
  name: "where",
  tokens: ["/where", "/pwd", "/binding"],
  kind: "where",
  group: "Repo / session",
  help: [{ syntax: "/where", aliases: ["/pwd", "/binding"], description: "查看当前 repo binding" }],
  handle: (context) => context.where(),
});

const unbindCommand = defineExactCommand({
  name: "unbind",
  tokens: ["/unbind", "/unpin"],
  kind: "unbind",
  group: "Repo / session",
  help: [{ syntax: "/unbind", aliases: ["/unpin"], description: "解除 repo binding" }],
  handle: (context) => context.unbind(),
});

const newCommand = defineExactCommand({
  name: "new",
  tokens: ["/new"],
  kind: "new",
  group: "Repo / session",
  help: [{ syntax: "/new", description: "清空当前 topic session，下次消息创建全新上下文" }],
  handle: (context) => context.newSession(),
});

const restartCommand = defineExactCommand({
  name: "restart",
  tokens: ["/restart"],
  kind: "restart",
  group: "Repo / session",
  help: [
    {
      syntax: "/restart",
      description: "取消当前任务，重启当前 topic Agent 并恢复同一 session",
    },
  ],
  handle: (context) => context.restart(),
});

const cancelCommand = defineExactCommand({
  name: "cancel",
  tokens: ["/cancel", "/stop", "取消", "停止"],
  kind: "cancel",
  group: "Repo / session",
  help: [
    {
      syntax: "/cancel",
      aliases: ["/stop", "取消", "停止"],
      description: "中断当前任务",
    },
  ],
  handle: (context) => context.cancel(),
});

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  helpCommand,
  capabilitiesCommand,
  agentCommand,
  modelCommand,
  modeCommand,
  permissionCommand,
  profileCommand,
  bindCommand,
  whereCommand,
  unbindCommand,
  newCommand,
  restartCommand,
  cancelCommand,
];

export class SlashCommandController {
  private readonly commands: readonly SlashCommand[];

  constructor(commands: readonly SlashCommand[]) {
    this.commands = [...commands];
    const ownersByToken = new Map<string, SlashCommand>();
    for (const command of this.commands) {
      for (const token of command.tokens) {
        const normalizedToken = token.toLowerCase();
        const existing = ownersByToken.get(normalizedToken);
        if (existing !== undefined) {
          throw new Error(
            `slash command token ${token} is registered by both ${existing.name} and ${command.name}`,
          );
        }
        ownersByToken.set(normalizedToken, command);
      }
    }
  }

  resolve(input: string): SlashCommandInvocation | null {
    for (const owner of this.commands) {
      const command = owner.parse(input);
      if (command !== null) return { owner, command };
    }
    return null;
  }

  async dispatch(invocation: SlashCommandInvocation, context: SlashCommandContext): Promise<void> {
    await invocation.owner.handle(context, invocation.command);
  }

  helpGroups(): readonly CommandHelpGroup[] {
    const titles: readonly CommandGroup[] = ["Discovery", "Repo / session"];
    return titles.map((title) => ({
      title,
      entries: this.commands
        .filter((command) => command.group === title)
        .flatMap((command) => command.help),
    }));
  }

  renderHelp(): string {
    return [
      ...this.helpGroups().flatMap((group) => [
        `**${group.title}**`,
        ...group.entries.map(renderCommandHelpEntry),
        "",
      ]),
      "裸 /agent /model /mode /permission 只查询可选项，不会修改状态。",
    ].join("\n");
  }

  registeredCommands(): readonly SlashCommand[] {
    return this.commands;
  }
}

export const slashCommandController = new SlashCommandController(SLASH_COMMANDS);
export const HUMMING_COMMAND_HELP_GROUPS = slashCommandController.helpGroups();

export function renderCommandHelpBody(): string {
  return slashCommandController.renderHelp();
}

function parseOptionalSingleArgument(input: string, token: string): string | null {
  const rest = stripLeadingToken(input, token);
  if (rest === null || /\s/.test(rest)) return null;
  return rest;
}

function tokenMatches(tokens: readonly string[], value: string): boolean {
  return tokens.some((token) => token.toLowerCase() === value.toLowerCase());
}

function stripLeadingToken(text: string, token: string): string | null {
  const textLower = text.toLowerCase();
  const tokenLower = token.toLowerCase();
  if (textLower === tokenLower) return "";
  if (!textLower.startsWith(tokenLower)) return null;
  const next = text.charAt(token.length);
  if (next.trim().length !== 0) return null;
  return text.slice(token.length).trim();
}

function renderCommandHelpEntry(entry: CommandHelpEntry): string {
  const aliases = entry.aliases?.length ? `（别名：${entry.aliases.join("、")}）` : "";
  return `• ${entry.syntax}${aliases} — ${entry.description}`;
}

function rejectWrongCommand(name: string, command: LarkCommand): never {
  throw new Error(`slash command ${name} cannot handle invocation kind ${command.kind}`);
}
