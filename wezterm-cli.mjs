import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text) {
  return String(text || "").replace(ANSI_REGEX, "");
}

export function findWeztermBinary() {
  if (process.env.WEZMUX_CLI_BIN && fs.existsSync(process.env.WEZMUX_CLI_BIN)) {
    return process.env.WEZMUX_CLI_BIN;
  }
  const candidates = [];
  if (process.env.WEZTERM_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.WEZTERM_EXECUTABLE_DIR, "wezterm.exe"));
    candidates.push(path.join(process.env.WEZTERM_EXECUTABLE_DIR, "wezterm"));
  }
  if (process.platform === "win32") {
    candidates.push(
      path.join(os.homedir(), "tools", "wezmux", "Wezmux", "wezterm.exe"),
      path.join(os.homedir(), "tools", "wezmux", "wezterm.exe"),
      path.join("C:\\Program Files\\WezTerm", "wezterm.exe"),
      path.join(os.homedir(), "scoop", "shims", "wezterm.exe")
    );
  } else {
    candidates.push("/Applications/Wezmux.app/Contents/MacOS/wezterm", "/usr/local/bin/wezterm", "/opt/homebrew/bin/wezterm");
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === "win32" ? "wezterm.exe" : "wezterm";
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function extractInstancePid(socketPath) {
  if (!socketPath) return null;
  const m = String(socketPath).match(/gui-sock-(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function normalizeSocketPath(socketPath) {
  if (!socketPath) return "";
  return path.normalize(String(socketPath));
}

export function discoverAllSockets() {
  const seen = new Set();
  const results = [];

  const addSock = (full, mtimeMs = 0, knownExists = false) => {
    const norm = normalizeSocketPath(full);
    if (!norm || seen.has(norm.toLowerCase())) return;
    const pid = extractInstancePid(norm);
    if (pid !== null && !isPidAlive(pid)) return;
    const st = lstatSafe(norm);
    if (!st && !knownExists) {
      // On Windows, AF_UNIX sockets may fail lstatSync while still being live; verify parent dir entry
      try {
        const parent = path.dirname(norm);
        const base = path.basename(norm);
        if (!fs.readdirSync(parent).includes(base)) return;
      } catch {
        return;
      }
    }
    seen.add(norm.toLowerCase());
    results.push({ socket: norm, instance_pid: pid, mtimeMs: st ? st.mtimeMs : mtimeMs });
  };

  if (process.env.WEZTERM_UNIX_SOCKET) {
    addSock(process.env.WEZTERM_UNIX_SOCKET, Date.now(), false);
  }

  const dirs = [
    path.join(os.homedir(), ".local", "share", "wezterm"),
    path.join(os.homedir(), ".local", "share", "wezmux"),
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "wezterm") : "",
  ].filter(Boolean);

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith("gui-sock-") || name.startsWith("sock")) {
        addSock(path.join(dir, name), 0, true);
      }
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

export function discoverSocketPath() {
  const all = discoverAllSockets();
  if (process.env.WEZTERM_UNIX_SOCKET) {
    const normEnv = normalizeSocketPath(process.env.WEZTERM_UNIX_SOCKET).toLowerCase();
    const match = all.find((s) => s.socket.toLowerCase() === normEnv);
    if (match) return match.socket;
  }
  return all.length > 0 ? all[0].socket : null;
}

export function runWeztermCli(args, { stdinText = null, timeoutMs = 15000, socket = null } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findWeztermBinary();
    const env = { ...process.env };
    const sock = socket || discoverSocketPath();
    if (sock) env.WEZTERM_UNIX_SOCKET = sock;

    const child = spawn(bin, ["cli", "--no-auto-start", ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        reject(new Error(`wezterm cli ${args[0]} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`Failed to execute ${bin}: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr, bin, socket: sock });
        } else {
          reject(
            new Error(
              `wezterm cli ${args.join(" ")} exited with code ${code} [sock=${sock || "NONE"}]: ${stderr.trim() || stdout.trim()}`
            )
          );
        }
      }
    });

    if (stdinText !== null && stdinText !== undefined) {
      child.stdin.write(stdinText, "utf8");
    }
    child.stdin.end();
  });
}

export function detectLikelyAgent(pane) {
  const title = String(pane.title || "").toLowerCase();
  const tabTitle = String(pane.tab_title || "").toLowerCase();
  const combined = `${title} ${tabTitle}`;
  if (combined.includes("claude")) return "claude-code";
  if (combined.includes("codex")) return "codex";
  if (combined.includes("opencode")) return "opencode";
  if (combined.includes("gemini")) return "gemini";
  if (combined.includes("aider")) return "aider";
  return null;
}

export async function listPanes(socket = null) {
  const { stdout, socket: usedSock } = await runWeztermCli(["list", "--format", "json"], { socket });
  const panes = JSON.parse(stdout || "[]");
  const instancePid = extractInstancePid(usedSock);
  return panes.map((p) => ({
    ...p,
    socket: usedSock || "",
    instance_pid: instancePid,
    likely_agent: detectLikelyAgent(p),
  }));
}

export async function listAllPanes() {
  const sockets = discoverAllSockets();
  if (sockets.length === 0) {
    return listPanes();
  }
  const settled = await Promise.allSettled(sockets.map((s) => listPanes(s.socket)));
  const all = [];
  for (const res of settled) {
    if (res.status === "fulfilled") {
      all.push(...res.value);
    }
  }
  if (all.length === 0) {
    // Throw first error if all failed
    const firstErr = settled.find((r) => r.status === "rejected");
    if (firstErr) throw firstErr.reason;
  }
  return all;
}

export async function resolveTargetSocket(paneId, { socket = null, instancePid = null } = {}) {
  if (socket) return socket;
  if (instancePid !== null && instancePid !== undefined) {
    const sockets = discoverAllSockets();
    const match = sockets.find((s) => s.instance_pid === Number(instancePid));
    if (match) return match.socket;
    throw new Error(`No live WezTerm/Wezmux instance found with instance_pid=${instancePid}`);
  }
  const all = await listAllPanes();
  const matches = all.filter((p) => p.pane_id === Number(paneId));
  if (matches.length === 1) {
    return matches[0].socket;
  }
  if (matches.length > 1) {
    const selfSock = normalizeSocketPath(process.env.WEZTERM_UNIX_SOCKET || "").toLowerCase();
    const sameInstance = matches.find((m) => normalizeSocketPath(m.socket).toLowerCase() === selfSock);
    if (sameInstance) return sameInstance.socket;
    const summary = matches.map((m) => `instance_pid=${m.instance_pid} (workspace=${m.workspace}, title=${m.title})`).join("; ");
    throw new Error(`Multiple WezTerm/Wezmux instances have pane_id=${paneId}: ${summary}. Pass instance_pid to disambiguate.`);
  }
  return discoverSocketPath();
}

export async function getPaneText(paneId, { startLine = null, endLine = null, escapes = false, tailLines = 80, socket = null } = {}) {
  const args = ["get-text", "--pane-id", String(paneId)];
  if (escapes) args.push("--escapes");
  if (startLine !== null && startLine !== undefined) args.push("--start-line", String(startLine));
  if (endLine !== null && endLine !== undefined) args.push("--end-line", String(endLine));

  const { stdout } = await runWeztermCli(args, { socket });
  let text = escapes ? stdout : stripAnsi(stdout);
  if (tailLines && tailLines > 0) {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    text = lines.length > tailLines ? lines.slice(-tailLines).join("\n") : lines.join("\n");
  }
  return text;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendPaneText(paneId, text, { submit = false, noPaste = true, submitDelayMs = 120, socket = null } = {}) {
  const baseArgs = ["send-text", "--pane-id", String(paneId)];
  if (noPaste) baseArgs.push("--no-paste");

  if (text && text.length > 0) {
    await runWeztermCli(baseArgs, { stdinText: text, socket });
  }
  if (submit) {
    if (text && text.length > 0 && submitDelayMs > 0) {
      await sleep(submitDelayMs);
    }
    await runWeztermCli(["send-text", "--pane-id", String(paneId), "--no-paste"], { stdinText: "\r", socket });
  }
}

export async function spawnPane({
  mode = "split_right",
  paneId = null,
  cwd = null,
  workspace = null,
  command = null,
  percent = null,
  socket = null,
} = {}) {
  let args;
  if (mode === "new_window" || mode === "new_tab") {
    args = ["spawn"];
    if (mode === "new_window") args.push("--new-window");
    if (workspace) args.push("--workspace", workspace);
    if (paneId !== null && paneId !== undefined && mode === "new_tab") {
      args.push("--pane-id", String(paneId));
    }
    if (cwd) args.push("--cwd", cwd);
  } else {
    args = ["split-pane"];
    if (paneId !== null && paneId !== undefined) args.push("--pane-id", String(paneId));
    if (mode === "split_left") args.push("--left");
    else if (mode === "split_top") args.push("--top");
    else if (mode === "split_bottom") args.push("--bottom");
    else args.push("--right");
    if (percent) args.push("--percent", String(percent));
    if (cwd) args.push("--cwd", cwd);
  }

  if (Array.isArray(command) && command.length > 0) {
    args.push("--", ...command);
  } else if (typeof command === "string" && command.trim().length > 0) {
    if (process.platform === "win32") {
      args.push("--", "pwsh.exe", "-NoLogo", "-NoExit", "-Command", command);
    } else {
      args.push("--", "sh", "-lc", command);
    }
  }

  const { stdout } = await runWeztermCli(args, { socket });
  const newPaneId = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(newPaneId) ? stdout.trim() : newPaneId;
}

export async function activatePane(paneId, { socket = null } = {}) {
  await runWeztermCli(["activate-pane", "--pane-id", String(paneId)], { socket });
}

export async function killPane(paneId, { socket = null } = {}) {
  await runWeztermCli(["kill-pane", "--pane-id", String(paneId)], { socket });
}

export async function setTabTitle(paneId, title, { socket = null } = {}) {
  await runWeztermCli(["set-tab-title", "--pane-id", String(paneId), title], { socket });
}

export function emitWezmuxOsc({ status = null, message = null, title = null, tool = null, notify = null } = {}) {
  const chunks = [];
  if (status) chunks.push(`\x1b]7777;status;${status}\x07`);
  if (message !== null && message !== undefined) chunks.push(`\x1b]7777;message;${String(message).replace(/[\r\n\x07\x1b]+/g, " ").slice(0, 160)}\x07`);
  if (title) chunks.push(`\x1b]7777;title;${String(title).replace(/[\r\n\x07\x1b]+/g, " ").slice(0, 80)}\x07`);
  if (tool) chunks.push(`\x1b]7777;tool;${String(tool).replace(/[\r\n\x07\x1b]+/g, " ").slice(0, 40)}\x07`);
  if (notify) chunks.push(`\x1b]9;${String(notify).replace(/[\r\n\x07\x1b]+/g, " ").slice(0, 200)}\x07`);

  if (chunks.length === 0) return false;
  const payload = chunks.join("");

  const targets = process.platform === "win32" ? ["\\\\.\\CONOUT$"] : ["/dev/tty"];
  for (const target of targets) {
    try {
      const fd = fs.openSync(target, "w");
      try {
        fs.writeSync(fd, payload);
        return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // ignore if detached from console
    }
  }
  return false;
}
