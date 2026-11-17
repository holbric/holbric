import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function serverCommand() {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "holbric.js");
  return { command: process.execPath, args: [bin, "mcp"] };
}

const backup = (p) => { if (existsSync(p)) copyFileSync(p, p + ".holbric-backup"); };
function mergeJson(p, mutate) {
  let data = {};
  if (existsSync(p)) {
    const raw = readFileSync(p, "utf8").trim();
    if (raw) { try { data = JSON.parse(raw); } catch { throw new Error(`${p} is not valid JSON. Fix it or add Holbric by hand (see \`holbric connect <host> --print\`).`); } }
  }
  mutate(data);
  mkdirSync(dirname(p), { recursive: true });
  backup(p);
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

const tomlStr = (s) => JSON.stringify(s);
export function codexToml({ command, args }) {
  return `[mcp_servers.holbric]\ncommand = ${tomlStr(command)}\nargs = [${args.map(tomlStr).join(", ")}]\n`;
}

export function connect(host, { global = false, print = false } = {}) {
  const sc = serverCommand();
  const entry = { command: sc.command, args: sc.args };
  if (host === "cursor") {
    const p = global ? join(homedir(), ".cursor", "mcp.json") : join(process.cwd(), ".cursor", "mcp.json");
    if (print) return JSON.stringify({ mcpServers: { holbric: entry } }, null, 2);
    mergeJson(p, (d) => { d.mcpServers = { ...(d.mcpServers || {}), holbric: entry }; });
    return `Wrote Holbric to ${p}. Open Cursor Settings > MCP, check that "holbric" is on, then start a new chat.`;
  }
  if (host === "claude") {
    if (print) return `claude mcp add --scope user holbric -- ${[sc.command, ...sc.args].map((a) => JSON.stringify(a)).join(" ")}`;
    const has = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
    if (has) {
      spawnSync("claude", ["mcp", "remove", "--scope", "user", "holbric"], { stdio: "ignore" });
      const r = spawnSync("claude", ["mcp", "add", "--scope", "user", "holbric", "--", sc.command, ...sc.args], { stdio: "inherit" });
      if (r.status !== 0) throw new Error("`claude mcp add` failed. Run `holbric connect claude --print` and paste the command yourself.");
      return "Added Holbric to Claude Code (user scope). Start a fresh Claude Code session and run /mcp to check it.";
    }
    const p = join(homedir(), ".claude.json");
    mergeJson(p, (d) => { d.mcpServers = { ...(d.mcpServers || {}), holbric: { type: "stdio", ...entry, env: {} } }; });
    return `Claude CLI not found on PATH, so Holbric was written to ${p} (user scope). Start a fresh Claude Code session and run /mcp.`;
  }
  if (host === "codex") {
    const block = codexToml(sc);
    if (print) return block;
    const p = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    let text = existsSync(p) ? readFileSync(p, "utf8") : "";
    text = text.replace(/^\[mcp_servers\.holbric\][\s\S]*?(?=^\[|(?![\s\S]))/m, "").trimEnd();
    mkdirSync(dirname(p), { recursive: true });
    backup(p);
    writeFileSync(p, (text ? text + "\n\n" : "") + block);
    return `Wrote [mcp_servers.holbric] to ${p}. Start a new Codex session and run /mcp.`;
  }
  if (host === "gemini") {
    const p = join(homedir(), ".gemini", "settings.json");
    if (print) return JSON.stringify({ mcpServers: { holbric: entry } }, null, 2);
    mergeJson(p, (d) => { d.mcpServers = { ...(d.mcpServers || {}), holbric: entry }; });
    return `Wrote Holbric to ${p}. Start Gemini CLI again and run /mcp.`;
  }
  if (host === "windsurf") {
    const p = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    if (print) return JSON.stringify({ mcpServers: { holbric: entry } }, null, 2);
    mergeJson(p, (d) => { d.mcpServers = { ...(d.mcpServers || {}), holbric: entry }; });
    return `Wrote Holbric to ${p}. Refresh MCP servers in Windsurf (Cascade > MCP).`;
  }
  if (host === "vscode") {
    const p = join(process.cwd(), ".vscode", "mcp.json");
    const e = { type: "stdio", ...entry };
    if (print) return JSON.stringify({ servers: { holbric: e } }, null, 2);
    mergeJson(p, (d) => { d.servers = { ...(d.servers || {}), holbric: e }; });
    return `Wrote Holbric to ${p}. In VS Code, open the Chat view in agent mode and start the holbric server.`;
  }
  throw new Error(`Unknown host "${host}". Use: holbric connect cursor | claude | codex | gemini | windsurf | vscode  (add --print to see the config without writing it).`);
}
