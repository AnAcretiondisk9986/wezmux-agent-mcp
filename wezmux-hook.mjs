#!/usr/bin/env node
/**
 * Windows & cross-platform Claude Code hook bridge for vcabeli/wezmux + wezmux-agent-mcp.
 * - Emits OSC 7777 structured status & OSC 9 notifications to CONOUT$ (Windows) or /dev/tty (Unix)
 * - Auto-registers panes into the shared wezmux-agent-mcp SQLite registry on SessionStart
 * - Injects inbox unread notifications & pane identity on SessionStart / UserPromptSubmit
 * - Guards mcp__wezmux-agent__spawn_pane via PreToolUse permissionDecision: "ask"
 *
 * Usage: node --no-warnings wezmux-hook.mjs <event>
 * Events: session-start | prompt-submit | notification | needs-input | tool-use | stop | subagent-start | subagent-stop | spawn-guard
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPaneAgentName, getAgentByPaneId, getUnreadCount, readMessages, updateAgentStatusByPane } from "./db.mjs";
import { extractInstancePid, normalizeSocketPath } from "./wezterm-cli.mjs";

const event = process.argv[2] || "";

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function sanitize(str, maxLen = 120) {
  return String(str || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function writeOsc(seq) {
  if (!seq) return;
  if (!process.env.WEZTERM_PANE && process.env.TERM_PROGRAM !== "WezTerm") {
    return;
  }
  const target = process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty";
  try {
    const fd = fs.openSync(target, "w");
    try {
      fs.writeSync(fd, seq);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Non-fatal if no attached console
  }
}

function updateSubagentCount(sessionId, delta) {
  const safeId = (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const counterFile = path.join(os.tmpdir(), `wezmux-subagents-${safeId}`);
  let count = 0;
  try {
    count = Number.parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0;
  } catch {
    count = 0;
  }
  count = Math.max(0, count + delta);
  try {
    fs.writeFileSync(counterFile, String(count), "utf8");
  } catch {
    // ignore
  }
  return count;
}

function emitHookJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function main() {
  const raw = readStdinSync();
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  if (event === "spawn-guard") {
    const input = payload.tool_input || {};
    const mode = input.mode || "split_right";
    const reason = input.reason || "未提供原因";
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Agent 请求新建 WezTerm 窗体/分屏 (${mode})，原因: ${reason}。请确认是否许可；若希望它操作已有窗体/分屏，请拒绝并说明目标 pane_id。`,
      },
    });
    return;
  }

  const paneId = process.env.WEZTERM_PANE ? Number.parseInt(process.env.WEZTERM_PANE, 10) : null;
  const socket = normalizeSocketPath(process.env.WEZTERM_UNIX_SOCKET || "");
  const instancePid = extractInstancePid(socket);
  const cwd = payload.cwd || process.cwd();
  const osc = [];
  let dbStatus = null;
  let dbMsg = null;

  switch (event) {
    case "session-start": {
      osc.push("\x1b]7777;status;idle\x07");
      dbStatus = "idle";
      dbMsg = "Session ready";
      break;
    }
    case "prompt-submit": {
      const promptPreview = sanitize(payload.prompt || "", 80);
      osc.push("\x1b]7777;status;working\x07");
      if (promptPreview) {
        osc.push(`\x1b]7777;message;${promptPreview}\x07`);
      }
      dbStatus = "working";
      dbMsg = promptPreview || "Working...";
      break;
    }
    case "tool-use": {
      const toolName = sanitize(payload.tool_name || "", 40);
      osc.push("\x1b]7777;status;working\x07");
      if (toolName) {
        osc.push(`\x1b]7777;tool;${toolName}\x07`);
        dbMsg = `Using ${toolName}`;
      }
      dbStatus = "working";
      break;
    }
    case "needs-input": {
      osc.push("\x1b]7777;status;needs_input\x07");
      osc.push("\x1b]7777;message;Waiting for user input\x07");
      osc.push("\x1b]9;Claude Code needs your input\x07");
      dbStatus = "needs_input";
      dbMsg = "Waiting for user input";
      break;
    }
    case "notification": {
      const ntype = String(payload.notification_type || "");
      const msg = sanitize(payload.message || payload.title || "", 120);
      if (ntype === "idle_prompt") {
        osc.push("\x1b]7777;status;idle\x07");
        dbStatus = "idle";
      } else if (ntype.includes("permission") || ntype.includes("elicitation") || ntype.includes("input")) {
        osc.push("\x1b]7777;status;needs_input\x07");
        if (msg) osc.push(`\x1b]7777;message;${msg}\x07`);
        osc.push(`\x1b]9;${msg || "Claude Code needs approval"}\x07`);
        dbStatus = "needs_input";
        dbMsg = msg || "Needs approval";
      } else if (msg) {
        osc.push(`\x1b]7777;message;${msg}\x07`);
        osc.push(`\x1b]9;${msg}\x07`);
        dbMsg = msg;
      }
      break;
    }
    case "stop": {
      const preview = sanitize(payload.last_assistant_message || "Turn completed", 120);
      osc.push("\x1b]7777;status;idle\x07");
      osc.push(`\x1b]7777;message;${preview}\x07`);
      osc.push(`\x1b]9;Claude finished: ${preview.slice(0, 80)}\x07`);
      dbStatus = "idle";
      dbMsg = preview;
      break;
    }
    case "subagent-start": {
      const n = updateSubagentCount(payload.session_id, 1);
      osc.push(`\x1b]7777;subagents;${n}\x07`);
      break;
    }
    case "subagent-stop": {
      const n = updateSubagentCount(payload.session_id, -1);
      osc.push(`\x1b]7777;subagents;${n}\x07`);
      break;
    }
    default:
      break;
  }

  writeOsc(osc.join(""));

  let agentRecord = null;
  if (paneId !== null && !Number.isNaN(paneId) && (dbStatus || dbMsg)) {
    try {
      agentRecord = updateAgentStatusByPane(paneId, {
        status: dbStatus,
        status_message: dbMsg,
        cwd,
        socket,
        instance_pid: instancePid,
      });
    } catch {
      // Never block Claude Code hooks on DB errors
    }
  } else if (paneId !== null && !Number.isNaN(paneId)) {
    try {
      agentRecord = getAgentByPaneId(paneId, socket || null);
    } catch {
      // ignore
    }
  }

  if (event === "session-start" && paneId !== null && !Number.isNaN(paneId)) {
    const myName = agentRecord ? agentRecord.name : defaultPaneAgentName(paneId, instancePid);
    let unreadNote = "";
    try {
      const unread = getUnreadCount(myName);
      if (unread > 0) {
        unreadNote = ` You currently have ${unread} unread message(s) in your inbox — call mcp__wezmux-agent__read_messages(agent_name="${myName}") when appropriate.`;
      }
    } catch {
      // ignore
    }
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[WezTerm Multi-Agent Context] You are running inside WezTerm/Wezmux pane_id=${paneId}${instancePid ? ` (instance_pid=${instancePid})` : ""}, registered as "${myName}". Use mcp__wezmux-agent__* tools (list_panes, list_agents, send_message, read_messages, send_text, get_text) to communicate with ALL already-open WezTerm panes/agents. RULE: Operate already-open windows/panes first; NEVER call spawn_pane unless the user explicitly permits creating a new window/pane.${unreadNote}`,
      },
    });
  } else if (event === "prompt-submit" && paneId !== null && !Number.isNaN(paneId)) {
    const myName = agentRecord ? agentRecord.name : defaultPaneAgentName(paneId, instancePid);
    try {
      const unreadMsgs = readMessages({ agent_name: myName, unread_only: true, limit: 5, mark_read: false });
      if (unreadMsgs.length > 0) {
        const previews = unreadMsgs
          .map((m) => `#${m.id} from ${m.from_agent}${m.subject ? ` (${m.subject})` : ""}`)
          .join("; ");
        emitHookJson({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `[WezTerm Inbox] You (${myName}, pane_id=${paneId}) have ${unreadMsgs.length} unread message(s) from other WezTerm agents: ${previews}. If relevant, call mcp__wezmux-agent__read_messages(agent_name="${myName}").`,
          },
        });
      }
    } catch {
      // ignore
    }
  }
}

main();
