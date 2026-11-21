import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, "server.mjs");
const hookScript = path.join(__dirname, "wezmux-hook.mjs");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "wezmux-mcp-test-"));

const cleanEnv = { ...process.env, WEZMUX_AGENT_DATA_DIR: testDir };
delete cleanEnv.WEZTERM_UNIX_SOCKET;

try {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--no-warnings", serverScript],
    env: {
      ...cleanEnv,
      WEZTERM_PANE: "101",
    },
  });

  const client = new Client({ name: "smoke-tester", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Tools exposed:", tools.map((t) => t.name).join(", "));
  if (tools.length < 13) {
    throw new Error(`Expected 13 tools, got ${tools.length}`);
  }

  // Verify spawn_pane blocks unapproved calls
  const blockedSpawn = await client.callTool({
    name: "spawn_pane",
    arguments: { mode: "split_right", reason: "Testing block", user_approved: false },
  });
  if (!blockedSpawn.isError || !blockedSpawn.content[0].text.includes("Permission required")) {
    throw new Error(`Expected spawn_pane with user_approved=false to be blocked, got: ${JSON.stringify(blockedSpawn)}`);
  }

  // Test SessionStart hook auto-registration & context output
  const sessionOut = execFileSync(
    "node",
    ["--no-warnings", hookScript, "session-start"],
    {
      input: JSON.stringify({ cwd: process.cwd() }),
      env: { ...cleanEnv, WEZTERM_PANE: "102" },
      encoding: "utf8",
    }
  );
  const sessionJson = JSON.parse(sessionOut);
  if (!sessionJson.hookSpecificOutput?.additionalContext?.includes("pane_id=102")) {
    throw new Error(`Unexpected session-start hook output: ${sessionOut}`);
  }

  // Test PreToolUse spawn-guard hook
  const guardOut = execFileSync(
    "node",
    ["--no-warnings", hookScript, "spawn-guard"],
    {
      input: JSON.stringify({ tool_name: "mcp__wezmux-agent__spawn_pane", tool_input: { mode: "split_right", reason: "need shell" } }),
      env: { ...cleanEnv, WEZTERM_PANE: "101" },
      encoding: "utf8",
    }
  );
  const guardJson = JSON.parse(guardOut);
  if (guardJson.hookSpecificOutput?.permissionDecision !== "ask") {
    throw new Error(`Unexpected spawn-guard hook output: ${guardOut}`);
  }

  // Register agent-alpha and send message to auto-registered pane-102
  const regA = await client.callTool({
    name: "register_agent",
    arguments: { name: "agent-alpha", role: "architect", pane_id: 101, status: "working" },
  });
  if (regA.isError) throw new Error("register_agent failed");

  const sendRes = await client.callTool({
    name: "send_message",
    arguments: {
      from: "agent-alpha",
      to: "102",
      subject: "ping",
      body: "Hello auto-registered pane 102!",
      thread_id: "t-smoke",
    },
  });
  if (sendRes.isError) throw new Error("send_message to raw pane_id failed");

  // Verify UserPromptSubmit hook surfaces unread inbox notification
  const promptOut = execFileSync(
    "node",
    ["--no-warnings", hookScript, "prompt-submit"],
    {
      input: JSON.stringify({ prompt: "hello", cwd: process.cwd() }),
      env: { ...cleanEnv, WEZTERM_PANE: "102" },
      encoding: "utf8",
    }
  );
  const promptJson = JSON.parse(promptOut);
  if (!promptJson.hookSpecificOutput?.additionalContext?.includes("1 unread message")) {
    throw new Error(`Expected unread message notification in prompt-submit hook, got: ${promptOut}`);
  }

  // Read message as pane-102
  const readRes = await client.callTool({
    name: "read_messages",
    arguments: { agent_name: "pane-102", unread_only: true },
  });
  const parsedRead = JSON.parse(readRes.content[0].text);
  if (parsedRead.count !== 1 || parsedRead.messages[0].body !== "Hello auto-registered pane 102!") {
    throw new Error(`Unexpected read_messages output: ${readRes.content[0].text}`);
  }

  // File lock acquire & conflict check
  const lock1 = JSON.parse(
    (
      await client.callTool({
        name: "file_lock",
        arguments: { action: "acquire", file_path: "src/app.ts", owner_agent: "agent-alpha", reason: "editing" },
      })
    ).content[0].text
  );
  const lock2 = JSON.parse(
    (
      await client.callTool({
        name: "file_lock",
        arguments: { action: "acquire", file_path: "src/app.ts", owner_agent: "pane-102", reason: "editing" },
      })
    ).content[0].text
  );
  if (!lock1.acquired || lock2.acquired) {
    throw new Error("File lock conflict check failed");
  }

  await client.close();
  console.log("ALL MCP + MULTI-PANE + SPAWN-GUARD + HOOK SMOKE TESTS PASSED!");
} finally {
  try {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows may briefly hold SQLite WAL handle after stdio close
  }
}
