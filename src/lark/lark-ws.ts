import * as Lark from "@larksuiteoapi/node-sdk";
import { adaptToSdkLogger, type LarkLogger } from "../logger/logger.js";

const LARK_LOGGER_LEVEL = Lark.LoggerLevel.info;

const CARD_ACTION_TOAST_OK = {
  toast: { type: "success" as const, content: "已确认" },
};

export interface LarkWsOptions {
  appId: string;
  appSecret: string;
  logger: LarkLogger;
  onMessage: (event: Lark.RawMessageEvent) => void;
  onCardAction: (event: Lark.CardActionEvent) => void;
}

/**
 * Long-lived WebSocket connection to Lark's event stream. Subscribes to
 * `im.message.receive_v1` and `card.action.trigger`; ignores other events
 * to avoid noisy SDK warnings.
 */
export class LarkWsConnection {
  private readonly wsClient: Lark.WSClient;
  private readonly logger: LarkLogger;
  private readonly onMessage: LarkWsOptions["onMessage"];
  private readonly onCardAction: LarkWsOptions["onCardAction"];

  constructor(opts: LarkWsOptions) {
    this.logger = opts.logger.child({ name: "lark-ws" });
    this.onMessage = opts.onMessage;
    this.onCardAction = opts.onCardAction;
    const sdkLogger = adaptToSdkLogger(opts.logger.child({ name: "lark-sdk" }));
    this.wsClient = new Lark.WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      loggerLevel: LARK_LOGGER_LEVEL,
      logger: sdkLogger,
    });
  }

  start(): void {
    const sdkLogger = adaptToSdkLogger(this.logger.child({ name: "lark-sdk" }));
    const dispatcher = new Lark.EventDispatcher({
      logger: sdkLogger,
      loggerLevel: LARK_LOGGER_LEVEL,
    }).register({
      "im.message.receive_v1": async (data) => {
        try {
          this.onMessage(data as Lark.RawMessageEvent);
        } catch (err) {
          this.logger.error({ err }, "onMessage handler threw");
        }
      },
      "im.message.message_read_v1": async () => {
        // suppress SDK warning noise
      },
      "im.message.reaction.created_v1": async () => {
        this.logger.debug("reaction created");
      },
      "im.message.reaction.deleted_v1": async () => {
        this.logger.debug("reaction deleted");
      },
      "card.action.trigger": async (data: Lark.RawCardActionEvent) => {
        try {
          const normalized = Lark.normalizeCardAction(data);
          if (normalized) this.onCardAction(normalized);
        } catch (err) {
          this.logger.error({ err }, "onCardAction handler threw");
        }
        return CARD_ACTION_TOAST_OK;
      },
    });

    this.logger.info("connecting to Lark via WebSocket");
    this.wsClient.start({ eventDispatcher: dispatcher });
    this.logger.info("WebSocket connected; listening for events");
  }
}
