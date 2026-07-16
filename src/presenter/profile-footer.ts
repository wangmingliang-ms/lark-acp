import type { SessionCardMeta } from "./presenter.js";

export function buildSessionProfileFooter(profile: SessionCardMeta): object {
  return {
    tag: "markdown" as const,
    content: `<font color="grey">${[
      `Agent: ${profile.agent}`,
      `Mode: ${profile.mode}`,
      `Model: ${profile.model}`,
      `Permission: ${profile.permission}`,
    ].join(" · ")}</font>`,
  };
}
