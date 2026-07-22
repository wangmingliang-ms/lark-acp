# Humming CLI Command Model Specification

**Status:** Approved design
**Date:** 2026-07-13

## 1. Purpose

This specification defines the target command model and behavior of the Humming CLI. It replaces
the current hand-written argument parser and consolidates overlapping Session commands around a
smaller domain model.

The redesign does not preserve compatibility with the existing CLI. Humming has no external users
or maintainers who depend on its current command syntax, so the new interface should optimize for
clarity, correctness, and maintainability rather than migration compatibility.

## 2. Domain story

A user operates a Humming Gateway, inspects available ACP Agents, and manages the Agent Session
associated with a Lark chat Topic.

The user may:

- run or manage the Gateway process;
- inspect an arbitrary Agent and the capabilities it would provide in a repository;
- inspect the live capabilities of the current Topic Session;
- bind the Topic to an existing Agent Session;
- describe the desired Agent, Model, Mode, Permission, and Config for the Topic;
- optionally attach a message that must be sent only after that desired configuration is applied;
- send a message to the current Topic Session without changing its configuration.

When a Topic is busy, configuration changes wait until the current Turn reaches its completion
boundary. Until application starts, later configuration requests update one pending desired
configuration. Repeated fields use last-write-wins semantics. If the desired Agent changes, all
accumulated Agent-specific controls remain caller-supplied desired values.

## 3. Vocabulary

| Term                      | Meaning                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Gateway**                | The long-running process connecting Lark to ACP Agents.                                                                                    |
| **Agent**                 | An ACP-compatible agent preset or invocation that can create Sessions.                                                                     |
| **Topic Session**         | The Agent Session selected for one Lark chat/thread scope.                                                                                 |
| **Session Profile**       | The desired Agent plus Model, Mode, Permission, and Config controls.                                                                       |
| **Current Profile**       | The profile currently active for a Topic Session.                                                                                          |
| **Pending Configuration** | The single caller-supplied desired profile change waiting to be applied at a Turn boundary.                                                |
| **Message**               | User-facing content submitted for Agent processing. `task`, `prompt`, and `queue` are implementation terms and are not exposed by the CLI. |
| **Agent Capabilities**    | Models, modes, and config options reported by probing an arbitrary Agent.                                                                  |
| **Session Capabilities**  | The live capabilities and current values reported by the current Topic Session.                                                            |

## 4. Command tree

```text
humming
├── run | start | stop | restart | status | logs
│   (top-level shortcuts for the corresponding gateway commands)
├── gateway
│   ├── run
│   ├── start
│   ├── stop
│   ├── restart
│   ├── status
│   └── logs
├── agent
│   ├── list
│   ├── capabilities
│   ├── models
│   ├── modes
│   └── permissions
├── session
│   ├── list
│   ├── bind
│   ├── capabilities
│   ├── models
│   ├── modes
│   ├── permissions
│   ├── configure
│   └── send
├── setup
├── init
├── update
└── autostart
```

Command names express actions or resources. All business values use named options. Positional
business arguments are not accepted.

The only positional pass-through is an explicit external Agent command after `--`:

```bash
humming gateway run -- node ./my-agent.js --acp
```

Unknown options, extra positional arguments, missing required options, and conflicting input
sources are errors.

The top-level Gateway shortcuts and their `humming gateway ...` forms register the same Commander
actions and therefore have identical options, validation, persistence, and lifecycle behavior.

## 5. Common option conventions

```text
-a, --agent <id>
-m, --model <id>
    --mode <id>
-p, --permission <mode>
-c, --config <id=value>       repeatable
-C, --cwd <path>
    --chat-id <id>
    --thread-id <id>
    --session-id <id>
    --json
```

Message input uses exactly one of:

```text
    --message <text>
    --message-file <path>
    --message-stdin
```

Commands running inside a Humming-spawned Agent may derive chat and thread scope from
`HUMMING_CHAT_ID` and `HUMMING_THREAD_ID`. Explicit options override derived scope.

## 6. Gateway commands

```bash
humming gateway run
humming gateway start
humming gateway stop
humming gateway restart
humming gateway status
humming gateway logs
```

- `gateway run` runs in the foreground, writes logs to the terminal, and stops on `Ctrl+C`.
- `gateway start` starts the managed background process and returns control to the terminal.
- `gateway stop`, `restart`, `status`, and `logs` operate on that managed process.
- Agent selection and other Gateway values are named options.
- `gateway run` may receive an external Agent command after `--`.

## 7. Agent inspection commands

```bash
humming agent list
humming agent capabilities --agent copilot
humming agent models --agent copilot
humming agent modes --agent copilot
humming agent permissions --agent copilot
```

`agent capabilities` starts a short-lived probe for the selected Agent in the selected cwd. It
does not read, change, or replace the current Topic Session.

`models`, `modes`, and `permissions` are projections of the same Agent capability result. They do
not implement separate probe paths.

All inspection commands support `--json`. `--agent` is required except for `agent list`.

## 8. Session inspection commands

```bash
humming session capabilities
humming session models
humming session modes
humming session permissions
```

Session inspection identifies the current Topic Session through chat/thread scope. It does not
accept `--agent`; the current Session already owns its Agent identity.

Session inspection is not delegated to an Agent probe:

```text
agent capabilities   -> short-lived target Agent probe
session capabilities -> live current Topic Session query
```

`models`, `modes`, and `permissions` are projections of the live Session capability result. Agent
and Session projections share schemas and formatters but retain distinct data sources.

## 9. Session configuration

### 9.1 Command

```bash
humming session configure --agent copilot
humming session configure --model gpt-5.6 --mode agent
humming session configure --permission alwaysAsk
humming session configure --config approval_mode=auto
```

`configure` replaces the previous `set-agent`, `set-control`,
`set-pending-target-profile`, and handoff command concepts.

At least one profile field is required:

- Agent
- Model
- Mode
- Permission
- one or more Config values

A message is optional:

```bash
humming session configure \
  --agent copilot \
  --model gpt-5.6 \
  --mode agent \
  --message-file task.md
```

A message by itself is not a configuration. Callers must use `session send` when no profile field
changes.

### 9.2 Desired Agent resolution

Every configuration request resolves one **Desired Agent**:

1. the Agent explicitly supplied by the request;
2. otherwise the Agent already held by Pending Configuration;
3. otherwise the current Topic Session Agent.

Model, Mode, and Config values are Agent-specific. The calling Agent must inspect the Desired
Agent's capabilities and supply appropriate values. `session configure` trusts those values and
does not automatically probe or validate target Agent capabilities.

Permission is a Humming policy constrained by the CLI input schema.

### 9.3 Pending Configuration ownership

Each Topic may have at most one Pending Configuration. The Gateway is its single semantic owner.
Pending Configuration is the canonical representation of all not-yet-applied profile changes.

The implementation must not maintain competing semantic truth in separate pending Agent,
pending Controls, and pending Task records. Persistence and in-memory scheduling may use separate
technical representations only if they are deterministic projections of the same canonical
Pending Configuration and cannot be independently mutated.

### 9.4 Merge rules

Before application begins, a later `configure` request merges into the existing Pending
Configuration:

- previously absent fields are added;
- repeated scalar fields use the later value;
- repeated Config keys use the later value;
- Config keys not mentioned by the later request are retained;
- a later message replaces an earlier attached message;
- omitting a field does not clear the pending value.

Conceptually:

```text
pending := merge(pending, incoming)
```

The CLI and control protocol validate input shape, but the Gateway does not query Agent capabilities
before replacing the Pending Configuration. If the Desired Agent changes, the caller is responsible
for selecting controls from that Agent's capabilities.

Explicit clearing, where supported, must use an explicit option value such as `--model auto`; it is
never inferred from omission.

### 9.5 Application lifecycle

```text
receive configure
  -> resolve Desired Agent
  -> merge with Pending Configuration
  -> persist the Pending Configuration
  -> wait for the current Turn boundary when busy
  -> apply target profile
  -> start, resume, or switch the target Agent Session
  -> apply Agent-specific controls
  -> send the attached Message, if present
  -> clear Pending Configuration
```

The profile change and attached Message form one ordered operation. The Message must never be sent
before the target profile is successfully active.

### 9.6 Failure behavior

- `session configure` does not perform a target Agent probe.
- Agent-specific control errors are surfaced when the target Agent actually applies the controls.
- Failure to start or resume the target Agent leaves the current Session selected and does not send
  the attached Message.
- Failure while applying controls does not send the attached Message.
- Failure must be surfaced through the existing CLI/control response and Topic notification
  mechanisms.
- No success-shaped fallback may hide partial failure.

## 10. Sending messages

```bash
humming session send --message "Fix the failing test"
humming session send --message-file task.md
humming session send --message-stdin
```

`send` submits a Message to the current Topic Session. It replaces the user-facing `queue-task`
concept.

If the Session is busy, Humming schedules delivery internally; the CLI does not expose queue
terminology. If a Pending Configuration already exists, the Message must not overtake that
configuration. Messages attached directly to `configure` retain the stronger atomic guarantee
defined in section 9.

Exactly one message input source is required.

## 11. Session binding and listing

```bash
humming session list --agent claude --cwd /repo
humming session bind --agent claude --session-id sess_123
```

All values remain named options. Binding must continue to verify that the selected Agent Session
belongs to the current chat repository and must not implicitly change the chat-to-repository
binding.

## 12. State and invariants

The implementation must preserve these invariants:

1. A CLI invocation resolves to exactly one command.
2. A Topic has at most one current profile and one Pending Configuration.
3. Only the Gateway owns and mutates Pending Configuration.
4. Pending changes are merged field-by-field with last-write-wins semantics.
5. CLI and control-protocol input shape is validated before entering Pending Configuration.
6. The calling Agent owns capability discovery and selection of Agent-specific control values.
7. `session configure` does not automatically probe target Agent capabilities.
8. A Message attached to `configure` is sent only after the complete target profile is active.
9. Failed configuration does not damage the current Session or partially replace valid pending
   state.
10. Capability projections do not duplicate probe or live-query implementations.
11. CLI parsing does not read or mutate Session state.
12. External JSON and file content is schema-validated before entering application behavior.

## 13. Implementation architecture

```text
CLI text
  -> Commander command and option declarations
  -> Zod validation of external values
  -> command-specific typed input
  -> command handler
  -> existing Gateway / Session / Agent / Process services
```

Use:

- **Commander** for command structure, named options, required options, conflicts, generated help,
  and unknown-argument rejection;
- **Zod 4 as a direct dependency** for `settings.json`, environment values, control/config input,
  and other external data.

Do not hand-write a replacement argv parser, option-source counter, or JSON schema validator.

The target module structure is:

```text
bin/
├── humming.ts
└── cli/
    ├── program.ts
    ├── context.ts
    ├── config/
    │   ├── schema.ts
    │   └── load.ts
    └── commands/
        ├── gateway.ts
        ├── agent.ts
        ├── session.ts
        ├── setup.ts
        ├── init.ts
        ├── update.ts
        └── autostart.ts
```

`bin/humming.ts` should contain only bootstrap, program construction, and top-level error handling.
Existing Gateway, Agent registry, and process-control implementations should be reused rather than
reimplemented.

## 14. Documentation contract

The implementation must update these sources together:

- `README.md`;
- repository `CLAUDE.md`;
- `templates/home/AGENTS.md`;
- Commander-generated `--help` declarations.

`templates/home/AGENTS.md` remains the canonical home guidance template used to generate both
`~/.humming/AGENTS.md` and `~/.humming/CLAUDE.md`.

Agent guidance must teach:

- named-option syntax;
- the difference between Agent probe and live Session capabilities;
- using `session configure` for any profile change;
- attaching a Message to `configure` for an atomic profile-change-and-message operation;
- using `session send` only when no profile change is required.

## 15. Acceptance scenarios

1. **Caller-owned capability selection**
   - Current Agent is Claude.
   - The calling Agent probes Copilot capabilities once.
   - User configures Copilot plus a Model.
   - `session configure` trusts the supplied Model without another probe.

2. **Later Agent override**
   - Pending Configuration targets Claude with a Claude Model.
   - A later request changes only the Agent to Copilot.
   - Humming preserves the accumulated Model; the caller must replace it when incompatible.

3. **Field-level merge**
   - A request sets Agent and Model.
   - A later request sets Mode.
   - One Pending Configuration contains all three fields.

4. **Last write wins**
   - A pending request sets Model A.
   - A later request sets Model B.
   - The pending Model is B.

5. **Atomic attached Message**
   - A configuration includes an Agent, controls, and Message.
   - The current Turn completes.
   - Humming activates the target profile before sending the Message.

6. **Apply failure**
   - Target Session startup fails after configuration was accepted.
   - The previous Session remains current and the attached Message is not sent.

7. **Live versus probe capabilities**
   - `agent models --agent copilot` probes Copilot.
   - `session models` reads the current Topic Session.
   - Neither command substitutes the other's data source.

8. **Strict CLI**
   - Positional Agent input, unknown options, extra arguments, and conflicting message sources are
     rejected with actionable errors.
