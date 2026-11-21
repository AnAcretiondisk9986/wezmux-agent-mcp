# wezmux-agent-mcp

A multi-window, multi-agent MCP server and cross-platform hook bridge for **WezTerm** and **[vcabeli/wezmux](https://github.com/vcabeli/wezmux)**.

It allows AI coding agents running inside different WezTerm / Wezmux windows, tabs, workspaces, and split panes (such as multiple Claude Code instances) to discover each other, exchange structured messages, coordinate file edits with advisory locks, and drive Wezmux's OSC 7777 sidebar status — while **prioritizing already-open panes and requiring explicit user permission before creating new windows or splits**.

## Features

- **Cross-Instance & Multi-Window Discovery (`list_panes`, `list_agents`)**
  - Discovers all live WezTerm / Wezmux GUI sockets (including Windows AF_UNIX sockets and stale PID filtering).
  - Detects active CLI agents (`claude-code`, `codex`, `opencode`, `gemini`, `aider`) and correlates them with registered agent identities.
- **Structured Multi-Agent Message Bus (`node:sqlite` WAL)**
  - Point-to-point messaging by agent name or raw `pane_id`, plus `*` broadcast, message threading (`thread_id`, `reply_to`), and blocking wait (`wait_for_message`).
  - Optional `wake_pane=true` injects a crisp wakeup prompt into an idle target pane so the peer agent reads its inbox immediately.
  - Messages addressed to a raw `pane_id` automatically migrate if that pane later registers a custom agent name.
- **Existing-Pane-First & Spawn Permission Gating (`spawn_pane`)**
  - MCP server instructions and Claude Code `SessionStart` context instruct agents to operate **already-open** windows and panes instead of spawning new ones.
  - Three-layer guard on `spawn_pane`:
    1. Claude Code `permissions.ask` + `PreToolUse` `spawn-guard` hook (`permissionDecision: "ask"`).
    2. Schema & policy validation (`user_approved`, `reason`, `WEZMUX_SPAWN_POLICY=deny|ask|native_dialog`).
    3. Optional native Windows confirmation dialog (`WEZMUX_SPAWN_OS_CONFIRM=1`).
- **Windows & Unix OSC 7777 / OSC 9 Hook Bridge (`wezmux-hook.mjs`)**
  - Brings Wezmux sidebar live status (`working` / `idle` / `needs_input`), tool indicators, subagent counters, and unread notifications to Windows (`\\.\CONOUT$`) as well as Unix (`/dev/tty`).
  - Auto-registers panes on `SessionStart` and notifies Claude of unread inbox messages on `UserPromptSubmit`.
- **Advisory File Locks (`file_lock`)**
  - Prevents parallel agents in different panes from overwriting the same file concurrently.

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`, no native C++ build tools required)
- **WezTerm** or **Wezmux** (`vcabeli/wezmux`)

## Installation

```bash
git clone https://github.com/AnAcretiondisk9986/wezmux-agent-mcp.git
cd wezmux-agent-mcp
npm install
npm test
```

### Register with Claude Code

```bash
claude mcp add-json --scope user wezmux-agent '{"type":"stdio","command":"node","args":["--no-warnings","/absolute/path/to/wezmux-agent-mcp/server.mjs"]}'
```

### Enable Hooks & Spawn Permission Gate (Optional, Recommended)

Merge [examples/claude-settings.hooks.json](examples/claude-settings.hooks.json) into `~/.claude/settings.json` (replacing `/path/to/wezmux-agent-mcp` with your cloned path).

For `vcabeli/wezmux`, see [examples/wezmux.lua](examples/wezmux.lua) for a starter `~/.wezmux.lua` configuration.

## Exposed MCP Tools (13)

| Category | Tool | Description |
| :--- | :--- | :--- |
| **Existing Panes** | `list_panes` | List all already-open windows, workspaces, tabs, and panes across live GUI instances |
| | `send_text` | Send text or commands to an open `pane_id` (optional `submit`, `instance_pid`) |
| | `get_text` | Read terminal output from an open `pane_id` (ANSI stripped by default) |
| | `focus_pane` | Focus an open `pane_id` |
| **Gated Lifecycle** | `spawn_pane` | **Restricted**: create a split/tab/window (requires explicit user permission) |
| | `kill_pane` | Close a specific `pane_id` |
| **Multi-Agent Bus** | `register_agent` | Register a pane with a memorable name & role (`architect`, `coder`, etc.) |
| | `list_agents` | List registered agents, live pane status, unread counts, and unregistered agent panes |
| | `send_message` | Send structured messages by agent name, `pane_id`, or `*`; optional `wake_pane` |
| | `read_messages` | Read unread or historical inbox messages |
| | `wait_for_message` | Block until a new message arrives on an inbox or thread |
| **Status & Safety** | `set_wezmux_status` | Update Wezmux sidebar state via OSC 7777 / OSC 9 and SQLite registry |
| | `file_lock` | Acquire, release, or list TTL-backed advisory file locks |

## Environment Variables

- `WEZMUX_AGENT_DATA_DIR`: Directory for `broker.db` (defaults to `~/.wezmux-agent-mcp`)
- `WEZMUX_CLI_BIN`: Override path to `wezterm` / `wezterm.exe`
- `WEZMUX_SPAWN_POLICY`: `ask` (default), `deny` (hard block all `spawn_pane`), or `native_dialog`
- `WEZMUX_SPAWN_OS_CONFIRM`: Set to `1` to force a Windows confirmation dialog even if client permissions are bypassed

## License

[MIT](LICENSE)
