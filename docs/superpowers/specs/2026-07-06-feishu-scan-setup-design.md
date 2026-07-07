# Feishu Link Setup Design

## Goal

Add a pure-local `humming setup` flow that mirrors Feishu/Lark's PersonalAgent onboarding: print the returned setup link, let the user open it in Feishu/Lark, receive the newly created bot app credentials, save them to `~/.humming/settings.json`, and start Humming with no manual developer-console work.

## Findings from Hermes

Hermes does not automate the Feishu developer console with a browser. It uses Feishu/Lark's accounts-domain app registration endpoint:

- `POST https://accounts.feishu.cn/oauth/v1/app/registration`
- `POST https://accounts.larksuite.com/oauth/v1/app/registration`

The sequence is:

1. `action=init` to confirm `client_secret` auth is supported.
2. `action=begin`, `archetype=PersonalAgent`, `auth_method=client_secret`, `request_user_info=open_id` to receive a device code and setup verification URL.
3. Print the returned setup URL. Feishu/Lark currently opens a guided flow from that link: the user logs in if prompted, selects or creates the target group, searches for the bot name, and confirms creation. Humming should explicitly say it does not display a QR code.
4. Poll with `action=poll`, the device code, and `tp=ob_app` until the user approves, denies, or the token expires.
5. On success, map `client_id` to Humming `credentials.appId` and `client_secret` to `credentials.appSecret`.
6. Best-effort probe `/open-apis/bot/v3/info` so the CLI can confirm the bot is reachable.

A live read-only probe on 2026-07-06 confirmed Feishu still returns a verification URL under `open.feishu.cn/page/launcher`, with interval and expiry fields.

## User-visible CLI

```bash
humming setup
humming setup feishu
```

Both commands run the same flow. Humming is currently Feishu/Lark-only, so `humming setup` defaults to Feishu/Lark.

The command should:

1. Resolve `--home` and `--config` with the same rules as `proxy`.
2. Install home templates.
3. Refuse to overwrite existing `credentials.appId` + `credentials.appSecret` unless the user explicitly passes `--force`.
4. Print the setup link and explain the Feishu/Lark guided flow. Do not render an ASCII QR code.
5. Poll until success, denial, expiry, or timeout.
6. Write/update only the `credentials` block in `settings.json`, preserving runtime, agents, bindings, and other existing settings.
7. chmod `settings.json` to `0600` best-effort.
8. Print a short success summary with masked App ID and bot name if known. Never print App Secret.

## Security and privacy rules

- Never print or log the full App Secret.
- Avoid printing full device code, user code, open_id, bot_open_id, chat_id, or tenant identifiers.
- App ID is less sensitive than App Secret, but user-facing output should mask it (`cli_…abcd`).
- Errors should report high-level failure reasons without dumping raw server responses.
- `settings.json` should be written atomically and chmodded to `0600`.

## Code structure

- Create `src/lark/registration.ts` for the registration client and setup-link progress boundary.
- Add `setup` parsing and execution in `bin/humming.ts`.
- Keep deterministic JSON read/merge/write helpers in the CLI layer because they update Humming's CLI settings file, not Lark transport behavior.
- Add tests before production code:
  - registration client HTTP body/response behavior,
  - setup-link progress behavior,
  - CLI parser recognizes `setup`, `setup feishu`, and `setup --force`,
  - settings merge preserves existing runtime/agents/bindings,
  - secret never appears in setup stdout.

## Acceptance checks

- `npm run fmt:check`
- `npm run build`
- `npm test`
- `git diff --check`
- A real non-secret live probe for `action=init` may be used, but no real setup flow should be executed without the user present to open the setup link and complete the Feishu/Lark guided flow.
