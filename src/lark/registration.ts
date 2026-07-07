export type FeishuRegistrationDomain = "feishu" | "lark";

export type FeishuRegistrationTransport = (url: string, body: URLSearchParams) => Promise<unknown>;

export type FeishuRegistrationCredentials = {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: FeishuRegistrationDomain;
  readonly ownerOpenId?: string;
};

export type FeishuBeginRegistrationResult = {
  readonly deviceCode: string;
  readonly qrUrl: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
};

export type FeishuBotProbeResult = {
  readonly botName?: string;
  readonly botOpenId?: string;
};

export type FeishuLinkRegistrationResult = FeishuRegistrationCredentials & {
  readonly botName?: string;
  readonly botOpenId?: string;
};

export type FeishuQrRegistrationResult = FeishuLinkRegistrationResult;

export type FeishuLinkRegistrationProgress =
  | { readonly kind: "connecting" }
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "polling" }
  | { readonly kind: "success"; readonly appId: string; readonly domain: FeishuRegistrationDomain }
  | { readonly kind: "failed"; readonly reason: string };

export type FeishuQrRegistrationProgress =
  | Exclude<FeishuLinkRegistrationProgress, { readonly kind: "link" }>
  | { readonly kind: "qr"; readonly qrUrl: string; readonly rendered: boolean };

export type FeishuRegistrationOptions = {
  readonly domain?: FeishuRegistrationDomain;
  readonly transport?: FeishuRegistrationTransport;
};

export type PollFeishuRegistrationOptions = FeishuRegistrationOptions & {
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type RunFeishuLinkRegistrationOptions = FeishuRegistrationOptions & {
  readonly timeoutSeconds?: number;
  readonly onProgress?: (event: FeishuLinkRegistrationProgress) => void;
};

export type RunFeishuQrRegistrationOptions = FeishuRegistrationOptions & {
  readonly timeoutSeconds?: number;
  readonly onProgress?: (event: FeishuQrRegistrationProgress) => void;
};

export type QrTerminalRenderer = {
  readonly render: (url: string) => void | Promise<void>;
};

const REGISTRATION_PATH = "/oauth/v1/app/registration";
const FEISHU_ACCOUNTS_BASE_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_BASE_URL = "https://accounts.larksuite.com";
const FEISHU_OPEN_BASE_URL = "https://open.feishu.cn";
const LARK_OPEN_BASE_URL = "https://open.larksuite.com";
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MILLISECONDS_PER_SECOND = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class FeishuRegistrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuRegistrationError";
  }
}

/**
 * Verify Feishu/Lark app registration supports the client-secret flow Humming needs.
 *
 * @throws {FeishuRegistrationError} when the server response is malformed or unsupported.
 */
export async function initFeishuRegistration(opts: FeishuRegistrationOptions = {}): Promise<void> {
  const domain = opts.domain ?? "feishu";
  const response = await postRegistration(domain, { action: "init" }, opts.transport);
  const methods = stringArrayField(response, "supported_auth_methods");
  if (!methods.includes("client_secret")) {
    throw new FeishuRegistrationError(
      `Feishu / Lark registration does not support client_secret auth (supported: ${methods.join(", ") || "none"})`,
    );
  }
}

/**
 * Start a PersonalAgent link-to-create registration and return the setup URL plus poll metadata.
 *
 * @throws {FeishuRegistrationError} when the server response is malformed.
 */
export async function beginFeishuRegistration(
  opts: FeishuRegistrationOptions = {},
): Promise<FeishuBeginRegistrationResult> {
  const domain = opts.domain ?? "feishu";
  const response = await postRegistration(
    domain,
    {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    },
    opts.transport,
  );

  const deviceCode = stringField(response, "device_code");
  const rawQrUrl = stringField(response, "verification_uri_complete");
  return {
    deviceCode,
    qrUrl: addHummingTrackingParams(rawQrUrl),
    userCode: optionalStringField(response, "user_code") ?? "",
    intervalSeconds: positiveNumberField(response, "interval") ?? DEFAULT_INTERVAL_SECONDS,
    expiresInSeconds:
      positiveNumberField(response, "expires_in") ??
      positiveNumberField(response, "expire_in") ??
      DEFAULT_EXPIRES_SECONDS,
  };
}

/**
 * Poll until Feishu/Lark returns app credentials, the user denies access, or the flow times out.
 *
 * @throws {FeishuRegistrationError} when a success response is malformed.
 */
export async function pollFeishuRegistration(
  opts: PollFeishuRegistrationOptions,
): Promise<FeishuRegistrationCredentials | null> {
  let domain = opts.domain ?? "feishu";
  let switchedDomain = false;
  const transport = opts.transport;
  const now = opts.now ?? (() => Date.now() / MILLISECONDS_PER_SECOND);
  const sleep = opts.sleep ?? sleepMs;
  const deadline = now() + opts.timeoutSeconds;

  while (now() < deadline) {
    const response = await postRegistration(
      domain,
      { action: "poll", device_code: opts.deviceCode, tp: "ob_app" },
      transport,
    );

    const userInfo = objectField(response, "user_info") ?? {};
    const tenantBrand = optionalStringField(userInfo, "tenant_brand");
    if (tenantBrand === "lark" && !switchedDomain) {
      domain = "lark";
      switchedDomain = true;
    }

    const appId = optionalStringField(response, "client_id");
    const appSecret = optionalStringField(response, "client_secret");
    if (appId !== undefined && appSecret !== undefined) {
      return {
        appId,
        appSecret,
        domain,
        ...optionalObjectStringField(userInfo, "open_id", "ownerOpenId"),
      };
    }

    const error = optionalStringField(response, "error");
    if (error === "access_denied" || error === "expired_token") return null;

    await sleep(opts.intervalSeconds * MILLISECONDS_PER_SECOND);
  }

  return null;
}

/** Render a QR URL to the terminal. Returns false when rendering fails. */
export async function renderQrToTerminal(
  _url?: string,
  _renderer?: QrTerminalRenderer,
): Promise<boolean> {
  return false;
}

/** Run init → begin → setup link → poll → best-effort bot probe. */
export async function runFeishuLinkRegistration(
  opts: RunFeishuLinkRegistrationOptions = {},
): Promise<FeishuLinkRegistrationResult | null> {
  const domain = opts.domain ?? "feishu";
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  opts.onProgress?.({ kind: "connecting" });
  await initFeishuRegistration({ domain, transport: opts.transport });
  const begin = await beginFeishuRegistration({ domain, transport: opts.transport });
  opts.onProgress?.({ kind: "link", url: begin.qrUrl });
  opts.onProgress?.({ kind: "polling" });
  const credentials = await pollFeishuRegistration({
    domain,
    deviceCode: begin.deviceCode,
    intervalSeconds: begin.intervalSeconds,
    timeoutSeconds: Math.min(begin.expiresInSeconds, timeoutSeconds),
    transport: opts.transport,
  });
  if (credentials === null) {
    opts.onProgress?.({ kind: "failed", reason: "not_authorized" });
    return null;
  }

  const bot = await probeFeishuBot(credentials).catch(() => null);
  opts.onProgress?.({ kind: "success", appId: credentials.appId, domain: credentials.domain });
  return {
    ...credentials,
    ...(bot?.botName !== undefined ? { botName: bot.botName } : {}),
    ...(bot?.botOpenId !== undefined ? { botOpenId: bot.botOpenId } : {}),
  };
}

/** Backward-compatible alias for callers that imported the earlier QR-named API. */
export async function runFeishuQrRegistration(
  opts: RunFeishuQrRegistrationOptions = {},
): Promise<FeishuQrRegistrationResult | null> {
  return runFeishuLinkRegistration({
    domain: opts.domain,
    transport: opts.transport,
    timeoutSeconds: opts.timeoutSeconds,
    onProgress: mapQrRegistrationProgress(opts.onProgress),
  });
}

function mapQrRegistrationProgress(
  onProgress: ((event: FeishuQrRegistrationProgress) => void) | undefined,
): ((event: FeishuLinkRegistrationProgress) => void) | undefined {
  if (onProgress === undefined) return undefined;
  return (event) => {
    if (event.kind === "link") {
      onProgress({ kind: "qr", qrUrl: event.url, rendered: false });
      return;
    }
    onProgress(event);
  };
}

/** Best-effort bot info probe used only for setup confirmation copy. */
export async function probeFeishuBot(
  credentials: FeishuRegistrationCredentials,
): Promise<FeishuBotProbeResult | null> {
  const openBase = openBaseUrl(credentials.domain);
  const tokenResponse = await postJson(
    `${openBase}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    },
  );
  const tenantAccessToken = optionalStringField(tokenResponse, "tenant_access_token");
  if (tenantAccessToken === undefined) return null;

  const botResponse = await getJson(`${openBase}/open-apis/bot/v3/info`, tenantAccessToken);
  const bot =
    objectField(botResponse, "bot") ?? objectField(objectField(botResponse, "data") ?? {}, "bot");
  if (bot === undefined) return null;
  return {
    ...optionalObjectStringField(bot, "app_name", "botName"),
    ...optionalObjectStringField(bot, "bot_name", "botName"),
    ...optionalObjectStringField(bot, "open_id", "botOpenId"),
  };
}

async function postRegistration(
  domain: FeishuRegistrationDomain,
  body: Readonly<Record<string, string>>,
  transport: FeishuRegistrationTransport = defaultRegistrationTransport,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(body);
  const response = await transport(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, params);
  return ensureObject(response);
}

async function defaultRegistrationTransport(url: string, body: URLSearchParams): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  body: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return ensureObject(await response.json());
}

async function getJson(url: string, bearerToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
  });
  return ensureObject(await response.json());
}

function accountsBaseUrl(domain: FeishuRegistrationDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_BASE_URL : FEISHU_ACCOUNTS_BASE_URL;
}

function openBaseUrl(domain: FeishuRegistrationDomain): string {
  return domain === "lark" ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL;
}

function addHummingTrackingParams(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("from", "humming");
  url.searchParams.set("tp", "humming");
  return url.toString();
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuRegistrationError("Feishu / Lark registration returned a malformed response");
  }
  return value as Record<string, unknown>;
}

function objectField(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = optionalStringField(obj, key);
  if (value === undefined) {
    throw new FeishuRegistrationError(`Feishu / Lark registration response missing ${key}`);
  }
  return value;
}

function optionalStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArrayField(obj: Record<string, unknown>, key: string): readonly string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function optionalObjectStringField(
  obj: Record<string, unknown>,
  fromKey: string,
  toKey: string,
): Record<string, string> {
  const value = optionalStringField(obj, fromKey);
  return value === undefined ? {} : { [toKey]: value };
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
