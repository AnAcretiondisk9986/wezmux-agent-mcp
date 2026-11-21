#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import {
  acquireFileLock,
  defaultPaneAgentName,
  getAgentByName,
  getAgentByPaneId,
  getDbPath,
  listAgents,
  listFileLocks,
  readMessages,
  registerAgent,
  releaseFileLock,
  resolveAgent,
  sendMessage,
  updateAgentStatusByPane,
} from "./db.mjs";
import {
  activatePane,
  discoverAllSockets,
  discoverSocketPath,
  emitWezmuxOsc,
  extractInstancePid,
  findWeztermBinary,
  getPaneText,
  killPane,
  listAllPanes,
  listPanes,
  normalizeSocketPath,
  resolveTargetSocket,
  sendPaneText,
  setTabTitle,
  spawnPane,
} from "./wezterm-cli.mjs";

const SELF_PANE_ID =
  process.env.WEZTERM_PANE !== undefined && process.env.WEZTERM_PANE !== ""
    ? Number.parseInt(process.env.WEZTERM_PANE, 10)
    : null;
const SELF_SOCKET = normalizeSocketPath(process.env.WEZTERM_UNIX_SOCKET || "");
const SELF_INSTANCE_PID = extractInstancePid(SELF_SOCKET);

function getDefaultSelfName() {
  if (SELF_PANE_ID !== null && !Number.isNaN(SELF_PANE_ID)) {
    const existing = getAgentByPaneId(SELF_PANE_ID, SELF_SOCKET || null);
    if (existing) return existing.name;
    return defaultPaneAgentName(SELF_PANE_ID, SELF_INSTANCE_PID);
  }
  return process.env.WEZMUX_AGENT_NAME || `agent-${process.pid}`;
}

function jsonContent(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorContent(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

function askNativeWindowsApproval({ mode, reason, command }) {
  if (process.platform !== "win32") return true;
  const detail = [
    `Agent 请求新建 WezTerm 窗体/分屏：`,
    `类型: ${mode}`,
    `原因: ${reason}`,
    command ? `命令: ${command}` : "",
    ``,
    `是否许可新建？（选择“否”将拒绝，Agent 应优先操作已打开的窗体/分屏）`,
  ]
    .filter(Boolean)
    .join("\n");

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$msg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(detail, "utf8").toString("base64")}'))
$res = [System.Windows.Forms.MessageBox]::Show($msg, 'WezTerm Agent 权限确认', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
if ($res -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", psScript], {
    timeout: 60000,
    windowsHide: true,
  });
  return r.status === 0;
}

const server = new McpServer(
  {
    name: "wezmux-agent-mcp",
    version: "1.1.0",
  },
  {
    instructions: [
      "WezTerm / Wezmux Multi-Agent Communication Server Rules:",
      "1. ALWAYS discover and operate ALREADY-OPEN windows, tabs, and panes first via `list_panes` and `list_agents`.",
      "2. Communicate with other agents/panes via `send_message`, `read_messages`, `wait_for_message`, `send_text`, and `get_text`.",
      "3. NEVER create a new window, tab, or split pane (`spawn_pane`) on your own. Creating a new window/pane REQUIRES explicit user permission first.",
    ].join("\n"),
  }
);

// 1. list_panes
server.tool(
  "list_panes",
  "List all already-open WezTerm/Wezmux windows, tabs, workspaces, and panes across live GUI instances, enriched with registered agent metadata and detected CLI agents.",
  {
    current_instance_only: z
      .boolean()
      .default(false)
      .describe("If true, only list panes from the current WezTerm/Wezmux GUI instance instead of all live instances."),
  },
  async ({ current_instance_only }) => {
    try {
      const panes = current_instance_only ? await listPanes(SELF_SOCKET || null) : await listAllPanes();
      const agents = listAgents();

      const matchAgentForPane = (p) => {
        const pSock = normalizeSocketPath(p.socket || "").toLowerCase();
        return (
          agents.find((a) => a.pane_id === p.pane_id && a.socket && normalizeSocketPath(a.socket).toLowerCase() === pSock) ||
          agents.find((a) => a.pane_id === p.pane_id && !a.socket) ||
          null
        );
      };

      const enriched = panes.map((p) => {
        const agent = matchAgentForPane(p);
        const sameSock = !SELF_SOCKET || normalizeSocketPath(p.socket || "").toLowerCase() === SELF_SOCKET.toLowerCase();
        return {
          instance_pid: p.instance_pid,
          pane_id: p.pane_id,
          window_id: p.window_id,
          tab_id: p.tab_id,
          workspace: p.workspace,
          title: p.title,
          tab_title: p.tab_title,
          cwd: p.cwd,
          is_active: p.is_active,
          is_self: SELF_PANE_ID !== null && p.pane_id === SELF_PANE_ID && sameSock,
          likely_agent: p.likely_agent,
          agent: agent
            ? {
                name: agent.name,
                role: agent.role,
                status: agent.status,
                status_message: agent.status_message,
                unread_count: agent.unread_count,
              }
            : null,
        };
      });

      return jsonContent({
        self_pane_id: SELF_PANE_ID,
        self_instance_pid: SELF_INSTANCE_PID,
        live_instances: discoverAllSockets().map((s) => ({ instance_pid: s.instance_pid, socket: s.socket })),
        wezterm_bin: findWeztermBinary(),
        db_path: getDbPath(),
        pane_count: enriched.length,
        panes: enriched,
      });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 2. spawn_pane (STRICTLY GATED: requires explicit user permission)
server.tool(
  "spawn_pane",
  "RESTRICTED: Create a new WezTerm/Wezmux split pane, tab, or window. Do NOT call this unless the user explicitly granted permission to create a new window/pane. Always check and operate already-open panes via list_panes first.",
  {
    mode: z
      .enum(["split_right", "split_left", "split_bottom", "split_top", "new_tab", "new_window"])
      .default("split_right")
      .describe("How to create the new pane."),
    reason: z
      .string()
      .optional()
      .describe("Clear explanation of why existing open panes cannot be used and why a new window/pane is required."),
    user_approved: z
      .boolean()
      .optional()
      .describe("Set to true ONLY after the user has explicitly granted permission to create a new window/pane."),
    pane_id: z.number().int().optional().describe("Reference pane_id for splitting or tab creation (defaults to current pane)."),
    instance_pid: z.number().int().optional().describe("Optional target WezTerm/Wezmux GUI instance PID."),
    cwd: z.string().optional().describe("Working directory for the new pane."),
    workspace: z.string().optional().describe("Workspace name (used when mode is new_window)."),
    command: z.string().optional().describe("Shell command to execute inside the new pane."),
    tab_title: z.string().optional().describe("Optional tab title to apply after spawning."),
    register_as: z.string().optional().describe("Optional agent name to pre-register for the spawned pane."),
    role: z.string().optional().describe("Optional agent role if register_as is provided."),
    percent: z.number().int().min(10).max(90).optional().describe("Split percentage (10-90) for split modes."),
  },
  async ({ mode, reason, user_approved, pane_id, instance_pid, cwd, workspace, command, tab_title, register_as, role, percent }) => {
    try {
      const policy = (process.env.WEZMUX_SPAWN_POLICY || "ask").toLowerCase();
      if (policy === "deny") {
        return errorContent(
          "Permission denied (WEZMUX_SPAWN_POLICY=deny): Creating new windows/panes is disabled. Use list_panes to operate already-open windows/panes."
        );
      }

      if (user_approved === false) {
        return errorContent(
          "Permission required: Do not create new windows/panes automatically. First inspect already-open panes via list_panes, or ask the user for explicit permission before calling spawn_pane."
        );
      }

      if (policy === "native_dialog" || process.env.WEZMUX_SPAWN_OS_CONFIRM === "1") {
        const ok = askNativeWindowsApproval({ mode, reason, command });
        if (!ok) {
          return errorContent("User denied permission in confirmation dialog to create a new window/pane.");
        }
      }

      const targetRef = pane_id ?? (SELF_PANE_ID !== null && !Number.isNaN(SELF_PANE_ID) ? SELF_PANE_ID : null);
      const sock =
        targetRef !== null
          ? await resolveTargetSocket(targetRef, { instancePid: instance_pid ?? null })
          : discoverSocketPath();
      const resolvedPid = extractInstancePid(sock);

      const newPaneId = await spawnPane({
        mode,
        paneId: targetRef,
        cwd,
        workspace,
        command,
        percent,
        socket: sock,
      });

      if (tab_title && typeof newPaneId === "number") {
        try {
          await setTabTitle(newPaneId, tab_title, { socket: sock });
        } catch {
          // non-fatal
        }
      }

      let registered = null;
      if (register_as && typeof newPaneId === "number") {
        registered = registerAgent({
          name: register_as,
          pane_id: newPaneId,
          workspace: workspace || "",
          role: role || "",
          cwd: cwd || "",
          status: "idle",
          socket: sock || "",
          instance_pid: resolvedPid,
        });
      }

      return jsonContent({
        pane_id: newPaneId,
        instance_pid: resolvedPid,
        mode,
        reason,
        cwd: cwd || null,
        workspace: workspace || null,
        registered_agent: registered,
      });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 3. send_text
server.tool(
  "send_text",
  "Send text or a command into an already-open WezTerm/Wezmux pane. Set submit=true to press Enter after sending.",
  {
    pane_id: z.number().int().describe("Target pane_id."),
    text: z.string().describe("Text or command to send to the pane."),
    submit: z.boolean().default(true).describe("Whether to send Enter (CR) after the text."),
    no_paste: z.boolean().default(true).describe("Use --no-paste (recommended for interactive CLIs like Claude Code)."),
    instance_pid: z.number().int().optional().describe("Optional WezTerm/Wezmux GUI instance PID if multiple instances share the same pane_id."),
  },
  async ({ pane_id, text, submit, no_paste, instance_pid }) => {
    try {
      const sock = await resolveTargetSocket(pane_id, { instancePid: instance_pid ?? null });
      await sendPaneText(pane_id, text, { submit, noPaste: no_paste, socket: sock });
      return jsonContent({
        ok: true,
        pane_id,
        instance_pid: extractInstancePid(sock),
        bytes: Buffer.byteLength(text, "utf8"),
        submit,
      });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 4. get_text
server.tool(
  "get_text",
  "Read recent terminal output from an already-open WezTerm/Wezmux pane (ANSI escape sequences stripped by default).",
  {
    pane_id: z.number().int().describe("Target pane_id."),
    tail_lines: z.number().int().min(1).max(2000).default(80).describe("Return the last N non-empty lines."),
    start_line: z.number().int().optional().describe("Optional WezTerm --start-line (negative values read scrollback)."),
    end_line: z.number().int().optional().describe("Optional WezTerm --end-line."),
    escapes: z.boolean().default(false).describe("Include raw ANSI escape sequences."),
    instance_pid: z.number().int().optional().describe("Optional WezTerm/Wezmux GUI instance PID if multiple instances share the same pane_id."),
  },
  async ({ pane_id, tail_lines, start_line, end_line, escapes, instance_pid }) => {
    try {
      const sock = await resolveTargetSocket(pane_id, { instancePid: instance_pid ?? null });
      const text = await getPaneText(pane_id, {
        startLine: start_line,
        endLine: end_line,
        escapes,
        tailLines: tail_lines,
        socket: sock,
      });
      return jsonContent({
        pane_id,
        instance_pid: extractInstancePid(sock),
        lines_returned: text ? text.split("\n").length : 0,
        text,
      });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 5. focus_pane
server.tool(
  "focus_pane",
  "Activate and focus an already-open WezTerm/Wezmux pane.",
  {
    pane_id: z.number().int().describe("Target pane_id to focus."),
    instance_pid: z.number().int().optional().describe("Optional WezTerm/Wezmux GUI instance PID."),
  },
  async ({ pane_id, instance_pid }) => {
    try {
      const sock = await resolveTargetSocket(pane_id, { instancePid: instance_pid ?? null });
      await activatePane(pane_id, { socket: sock });
      return jsonContent({ ok: true, focused_pane_id: pane_id, instance_pid: extractInstancePid(sock) });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 6. kill_pane
server.tool(
  "kill_pane",
  "Close/kill a specific WezTerm/Wezmux pane.",
  {
    pane_id: z.number().int().describe("Target pane_id to close."),
    instance_pid: z.number().int().optional().describe("Optional WezTerm/Wezmux GUI instance PID."),
  },
  async ({ pane_id, instance_pid }) => {
    try {
      const sock = await resolveTargetSocket(pane_id, { instancePid: instance_pid ?? null });
      await killPane(pane_id, { socket: sock });
      return jsonContent({ ok: true, killed_pane_id: pane_id, instance_pid: extractInstancePid(sock) });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 7. register_agent
server.tool(
  "register_agent",
  "Register this agent (or another open pane's agent) in the shared multi-agent registry with a memorable name and role.",
  {
    name: z.string().min(1).max(64).describe("Unique agent name, e.g. 'architect', 'coder', 'reviewer'."),
    role: z.string().default("").describe("Short description of this agent's responsibility."),
    pane_id: z.number().int().optional().describe("Pane ID (defaults to current WEZTERM_PANE)."),
    instance_pid: z.number().int().optional().describe("Optional WezTerm/Wezmux GUI instance PID."),
    status: z.enum(["working", "idle", "needs_input"]).default("idle").describe("Initial agent status."),
  },
  async ({ name, role, pane_id, instance_pid, status }) => {
    try {
      const targetPaneId = pane_id ?? (SELF_PANE_ID !== null && !Number.isNaN(SELF_PANE_ID) ? SELF_PANE_ID : null);
      let window_id = null;
      let workspace = "";
      let cwd = process.cwd();
      let socket = SELF_SOCKET || "";
      let resolvedPid = instance_pid ?? SELF_INSTANCE_PID;

      if (targetPaneId !== null) {
        try {
          const allPanes = await listAllPanes();
          const match =
            allPanes.find(
              (p) =>
                p.pane_id === targetPaneId &&
                (resolvedPid ? p.instance_pid === resolvedPid : !SELF_SOCKET || normalizeSocketPath(p.socket).toLowerCase() === SELF_SOCKET.toLowerCase())
            ) || allPanes.find((p) => p.pane_id === targetPaneId);
          if (match) {
            window_id = match.window_id;
            workspace = match.workspace || "";
            cwd = match.cwd || cwd;
            socket = match.socket || socket;
            resolvedPid = match.instance_pid ?? resolvedPid;
          }
        } catch {
          // allow registration even if CLI is unreachable
        }
      }

      const agent = registerAgent({
        name,
        pane_id: targetPaneId,
        window_id,
        workspace,
        role,
        cwd,
        status,
        socket,
        instance_pid: resolvedPid,
      });

      emitWezmuxOsc({ title: `${name}${role ? " · " + role : ""}`, status });
      return jsonContent({ ok: true, agent });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 8. list_agents
server.tool(
  "list_agents",
  "List all registered agents across all WezTerm/Wezmux windows and panes, plus any unregistered open panes running CLI agents.",
  {},
  async () => {
    try {
      const agents = listAgents();
      let allPanes = [];
      try {
        allPanes = await listAllPanes();
      } catch {
        // ignore
      }

      const isPaneAlive = (a) => {
        if (a.pane_id === null || a.pane_id === undefined) return null;
        if (allPanes.length === 0) return null;
        const aSock = normalizeSocketPath(a.socket || "").toLowerCase();
        return allPanes.some((p) => p.pane_id === a.pane_id && (!aSock || normalizeSocketPath(p.socket).toLowerCase() === aSock));
      };

      const enriched = agents.map((a) => ({
        ...a,
        pane_alive: isPaneAlive(a),
      }));

      const registeredKeys = new Set(
        agents
          .filter((a) => a.pane_id !== null && a.pane_id !== undefined)
          .map((a) => `${normalizeSocketPath(a.socket || "").toLowerCase()}#${a.pane_id}`)
      );

      const unregistered_open_panes = allPanes
        .filter((p) => !registeredKeys.has(`${normalizeSocketPath(p.socket || "").toLowerCase()}#${p.pane_id}`))
        .map((p) => ({
          instance_pid: p.instance_pid,
          pane_id: p.pane_id,
          window_id: p.window_id,
          workspace: p.workspace,
          title: p.title,
          likely_agent: p.likely_agent,
        }));

      return jsonContent({
        self_name: getDefaultSelfName(),
        self_pane_id: SELF_PANE_ID,
        self_instance_pid: SELF_INSTANCE_PID,
        agents: enriched,
        unregistered_open_panes,
      });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 9. send_message
server.tool(
  "send_message",
  "Send a structured message to another agent or open pane (by agent name, pane_id, or '*' broadcast) via the shared SQLite message bus. Set wake_pane=true to nudge an idle CLI agent in that pane immediately.",
  {
    to: z.string().min(1).describe("Target agent name, pane_id string (e.g. '25'), or '*' for broadcast."),
    body: z.string().min(1).describe("Message content."),
    subject: z.string().default("").describe("Optional short subject line."),
    from: z.string().optional().describe("Sender agent name (auto-detected from current pane if omitted)."),
    thread_id: z.string().default("").describe("Optional conversation thread identifier."),
    reply_to: z.number().int().optional().describe("Optional message ID this replies to."),
    wake_pane: z
      .boolean()
      .default(false)
      .describe("If true, also send a short wakeup prompt + Enter into the target's already-open WezTerm pane so an idle CLI agent reads and responds immediately."),
    instance_pid: z.number().int().optional().describe("Optional target WezTerm/Wezmux GUI instance PID when addressing by raw pane_id."),
  },
  async ({ to, body, subject, from, thread_id, reply_to, wake_pane, instance_pid }) => {
    try {
      const fromName = from || getDefaultSelfName();
      let targetName = to;
      let targetAgent = null;
      let targetSocket = null;
      let targetPaneId = null;

      if (to !== "*") {
        targetAgent = resolveAgent(to, SELF_SOCKET || null);
        if (targetAgent) {
          targetName = targetAgent.name;
          targetPaneId = targetAgent.pane_id;
          targetSocket = targetAgent.socket || null;
        } else if (/^\d+$/.test(to.trim())) {
          targetPaneId = Number(to.trim());
          try {
            targetSocket = await resolveTargetSocket(targetPaneId, { instancePid: instance_pid ?? null });
          } catch {
            // allow queuing even if pane lookup fails
          }
          const resolvedPid = instance_pid ?? extractInstancePid(targetSocket);
          const existingByPane = getAgentByPaneId(targetPaneId, targetSocket || null);
          if (existingByPane) {
            targetAgent = existingByPane;
            targetName = existingByPane.name;
          } else {
            targetName = defaultPaneAgentName(targetPaneId, resolvedPid);
            targetAgent = registerAgent({
              name: targetName,
              pane_id: targetPaneId,
              socket: targetSocket || "",
              instance_pid: resolvedPid,
              status: "idle",
            });
          }
        }
      }

      const msg = sendMessage({
        from_agent: fromName,
        to_agent: targetName,
        subject,
        body,
        thread_id,
        reply_to: reply_to ?? null,
      });

      const wokenPanes = [];
      if (wake_pane) {
        let allPanes = [];
        try {
          allPanes = await listAllPanes();
        } catch {
          // ignore
        }

        const targets = [];
        if (to === "*") {
          for (const a of listAgents()) {
            if (a.name !== fromName && a.pane_id !== null) {
              targets.push({ name: a.name, pane_id: a.pane_id, socket: a.socket || null });
            }
          }
          // Also include open unregistered panes that look like agents
          const knownPaneKeys = new Set(targets.map((t) => `${normalizeSocketPath(t.socket || "").toLowerCase()}#${t.pane_id}`));
          for (const p of allPanes) {
            const isSelf =
              SELF_PANE_ID !== null &&
              p.pane_id === SELF_PANE_ID &&
              (!SELF_SOCKET || normalizeSocketPath(p.socket).toLowerCase() === SELF_SOCKET.toLowerCase());
            const k = `${normalizeSocketPath(p.socket || "").toLowerCase()}#${p.pane_id}`;
            if (!isSelf && p.likely_agent && !knownPaneKeys.has(k)) {
              targets.push({ name: `pane-${p.pane_id}`, pane_id: p.pane_id, socket: p.socket });
            }
          }
        } else if (targetPaneId !== null && targetPaneId !== undefined) {
          targets.push({ name: targetName, pane_id: targetPaneId, socket: targetSocket });
        }

        const wakePrompt = `[wezmux-msg #${msg.id} from ${fromName}] ${subject ? subject + " — " : ""}Please call read_messages (agent_name="${targetName}") to read and reply.`;
        for (const t of targets) {
          try {
            const sock = t.socket || (await resolveTargetSocket(t.pane_id, { instancePid: instance_pid ?? null }));
            await sendPaneText(t.pane_id, wakePrompt, { submit: true, noPaste: true, socket: sock });
            wokenPanes.push({ pane_id: t.pane_id, instance_pid: extractInstancePid(sock), agent: t.name });
          } catch (wakeErr) {
            wokenPanes.push({ pane_id: t.pane_id, error: wakeErr.message });
          }
        }
      }

      return jsonContent({ ok: true, message: msg, woken_panes: wokenPanes });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 10. read_messages
server.tool(
  "read_messages",
  "Read messages sent to this agent (or broadcast '*') from the shared multi-agent message bus.",
  {
    agent_name: z.string().optional().describe("Recipient agent name (defaults to current registered agent or pane-<id>)."),
    unread_only: z.boolean().default(true).describe("Only return unread messages."),
    thread_id: z.string().default("").describe("Optional filter by thread_id."),
    from: z.string().default("").describe("Optional filter by sender agent name."),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum messages to return."),
    mark_read: z.boolean().default(true).describe("Mark returned direct messages as read."),
  },
  async ({ agent_name, unread_only, thread_id, from, limit, mark_read }) => {
    try {
      const resolved = agent_name ? resolveAgent(agent_name, SELF_SOCKET || null) : null;
      const recipient = resolved ? resolved.name : (agent_name || getDefaultSelfName());
      const messages = readMessages({
        agent_name: recipient,
        unread_only,
        thread_id,
        from_agent: from,
        limit,
        mark_read,
      });
      return jsonContent({ agent_name: recipient, count: messages.length, messages });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 11. wait_for_message
server.tool(
  "wait_for_message",
  "Wait (block/poll) until a new unread message arrives for this agent or thread, up to timeout_seconds.",
  {
    agent_name: z.string().optional().describe("Recipient agent name (defaults to current registered agent)."),
    thread_id: z.string().default("").describe("Optional thread_id to wait on."),
    from: z.string().default("").describe("Optional sender agent name to wait for."),
    timeout_seconds: z.number().int().min(1).max(180).default(30).describe("Maximum seconds to wait."),
    mark_read: z.boolean().default(true).describe("Mark received messages as read."),
  },
  async ({ agent_name, thread_id, from, timeout_seconds, mark_read }) => {
    try {
      const resolved = agent_name ? resolveAgent(agent_name, SELF_SOCKET || null) : null;
      const recipient = resolved ? resolved.name : (agent_name || getDefaultSelfName());
      const deadline = Date.now() + timeout_seconds * 1000;
      while (Date.now() < deadline) {
        const msgs = readMessages({
          agent_name: recipient,
          unread_only: true,
          thread_id,
          from_agent: from,
          limit: 20,
          mark_read,
        });
        if (msgs.length > 0) {
          return jsonContent({ timed_out: false, agent_name: recipient, count: msgs.length, messages: msgs });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return jsonContent({ timed_out: true, agent_name: recipient, count: 0, messages: [] });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 12. set_wezmux_status
server.tool(
  "set_wezmux_status",
  "Update this agent's status in the shared registry and emit Wezmux OSC 7777 status / OSC 9 notification to the Wezmux sidebar.",
  {
    status: z.enum(["working", "idle", "needs_input"]).optional().describe("Wezmux sidebar status indicator."),
    message: z.string().optional().describe("Short status preview text shown on the Wezmux sidebar card."),
    title: z.string().optional().describe("Conversation title shown on the Wezmux sidebar card."),
    notify: z.string().optional().describe("Optional OSC 9 toast notification text (increments unread badge)."),
  },
  async ({ status, message, title, notify }) => {
    try {
      let agent = null;
      if (SELF_PANE_ID !== null && !Number.isNaN(SELF_PANE_ID)) {
        agent = updateAgentStatusByPane(SELF_PANE_ID, {
          status: status ?? null,
          status_message: message ?? null,
          cwd: process.cwd(),
          socket: SELF_SOCKET,
          instance_pid: SELF_INSTANCE_PID,
        });
      }
      const oscSent = emitWezmuxOsc({ status, message, title, notify });
      return jsonContent({ ok: true, osc_sent: oscSent, agent });
    } catch (err) {
      return errorContent(err);
    }
  }
);

// 13. file_lock
server.tool(
  "file_lock",
  "Acquire, release, or list advisory file locks so parallel agents in different WezTerm panes do not overwrite each other's edits.",
  {
    action: z.enum(["acquire", "release", "list"]).describe("Lock operation."),
    file_path: z.string().optional().describe("File path to lock or unlock (required for acquire/release)."),
    owner_agent: z.string().optional().describe("Owner agent name (defaults to current agent)."),
    reason: z.string().default("").describe("Short reason for locking the file."),
    ttl_seconds: z.number().int().min(10).max(3600).default(300).describe("Lock TTL in seconds."),
  },
  async ({ action, file_path, owner_agent, reason, ttl_seconds }) => {
    try {
      const owner = owner_agent || getDefaultSelfName();
      if (action === "list") {
        return jsonContent({ locks: listFileLocks() });
      }
      if (!file_path) {
        return errorContent("file_path is required for acquire/release");
      }
      if (action === "acquire") {
        return jsonContent(acquireFileLock({ file_path, owner_agent: owner, reason, ttl_seconds }));
      }
      return jsonContent(releaseFileLock({ file_path, owner_agent: owner }));
    } catch (err) {
      return errorContent(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("wezmux-agent-mcp fatal error:", err);
  process.exit(1);
});
