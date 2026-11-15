#!/usr/bin/env node
// Installs the study-videos kit and registers it with the AI apps on this computer.
//
//   node install.mjs                                    YouTube tools only
//   node install.mjs --brightspace https://learn.myschool.edu   also connect Brightspace
//   node install.mjs --uninstall                        remove the app registrations
//
// Registers with every app it finds: Claude Desktop, Claude Code, and ChatGPT
// desktop / Codex (which share ~/.codex/config.toml). Safe to re-run.

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const KIT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const NODE = process.execPath; // absolute, because desktop apps start servers with a minimal PATH
const isWin = process.platform === "win32";
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const step = (m) => console.log(`\n${m}`);

function has(cmd) {
  const r = spawnSync(isWin ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}
function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: isWin });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
}

// ─── Servers to register ─────────────────────────────────────────────────────

let brightspaceUrl = value("--brightspace");
if (brightspaceUrl) {
  if (!/^https?:\/\//.test(brightspaceUrl)) brightspaceUrl = "https://" + brightspaceUrl;
  brightspaceUrl = new URL(brightspaceUrl).origin;
}

const servers = {
  "youtube-study": { command: NODE, args: [path.join(KIT, "youtube-study-mcp", "server.mjs")] },
};
if (brightspaceUrl) {
  servers.brightspace = {
    command: NODE,
    args: [path.join(KIT, "brightspace-mcp", "dist", "index.js")],
    env: { BRIGHTSPACE_URL: brightspaceUrl },
  };
}
const names = ["youtube-study", "brightspace"];

// ─── App config writers ──────────────────────────────────────────────────────

function claudeDesktopConfig() {
  const dir = process.platform === "darwin" ? path.join(HOME, "Library", "Application Support", "Claude")
    : isWin ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Claude")
    : path.join(HOME, ".config", "Claude");
  return { dir, file: path.join(dir, "claude_desktop_config.json") };
}

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
}

function writeClaudeDesktop(uninstall) {
  const { dir, file } = claudeDesktopConfig();
  if (!fs.existsSync(dir)) return warn("Claude Desktop not found, skipped");
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return warn(`Could not read ${file} (not valid JSON), skipped. Fix it and re-run.`); }
  }
  backup(file);
  cfg.mcpServers = cfg.mcpServers || {};
  for (const n of names) delete cfg.mcpServers[n];
  if (!uninstall) Object.assign(cfg.mcpServers, servers);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ok(`Claude Desktop: ${uninstall ? "removed" : "added " + Object.keys(servers).join(", ")}`);
}

function writeClaudeCode(uninstall) {
  if (!has("claude")) return warn("Claude Code CLI not found, skipped");
  for (const n of names) spawnSync("claude", ["mcp", "remove", "-s", "user", n], { stdio: "ignore", shell: isWin });
  if (!uninstall) {
    for (const [n, s] of Object.entries(servers)) {
      const envArgs = Object.entries(s.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      // The name goes before -e, because -e takes every following KEY=value.
      try {
        execFileSync("claude", ["mcp", "add", "-s", "user", n, ...envArgs, "--", s.command, ...s.args], { stdio: "ignore", shell: isWin });
      } catch {
        return warn(`Claude Code: could not add ${n}. Add it by hand: claude mcp add -s user ${n} -- "${s.command}" "${s.args.join('" "')}"`);
      }
    }
  }
  ok(`Claude Code: ${uninstall ? "removed" : "added " + Object.keys(servers).join(", ")}`);
}

// ChatGPT desktop and Codex read local MCP servers from ~/.codex/config.toml.
function writeCodex(uninstall) {
  const dir = path.join(HOME, ".codex");
  if (!fs.existsSync(dir) && !flag("--codex")) {
    return warn("ChatGPT desktop / Codex config not found, skipped (re-run with --codex to create it)");
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  let toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  backup(file);
  // Remove our earlier blocks: a [mcp_servers.<name>] table and its sub-tables, up to the next table header.
  for (const n of names) {
    const re = new RegExp(`^\\[mcp_servers\\.${n.replace("-", "\\-")}(\\.[^\\]]+)?\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "gm");
    toml = toml.replace(re, "");
  }
  toml = toml.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!uninstall) {
    const q = (s) => JSON.stringify(s); // TOML basic strings use the same escaping as JSON
    for (const [n, s] of Object.entries(servers)) {
      toml += `\n\n[mcp_servers.${n}]\ncommand = ${q(s.command)}\nargs = [${s.args.map(q).join(", ")}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 300\n`;
      if (s.env) toml += `\n[mcp_servers.${n}.env]\n` + Object.entries(s.env).map(([k, v]) => `${k} = ${q(v)}`).join("\n") + "\n";
    }
  }
  fs.writeFileSync(file, toml.trimStart() + "\n");
  ok(`ChatGPT desktop / Codex: ${uninstall ? "removed" : "added " + Object.keys(servers).join(", ")}`);
}

// Skills: Claude Code and Codex load SKILL.md folders. Other apps use the study_videos_guide tool instead.
function copySkill(uninstall) {
  const src = path.join(KIT, "skills", "study-videos");
  for (const base of [path.join(HOME, ".claude"), path.join(HOME, ".codex")]) {
    if (!fs.existsSync(base)) continue;
    const dest = path.join(base, "skills", "study-videos");
    fs.rmSync(dest, { recursive: true, force: true });
    if (!uninstall) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
    ok(`Skill ${uninstall ? "removed from" : "copied to"} ${dest}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const uninstall = flag("--uninstall");
console.log(`Study videos kit: ${uninstall ? "uninstalling" : "installing"} from ${KIT}`);

if (!uninstall) {
  step("1. Checking requirements");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) { console.error(`  Node ${process.versions.node} is too old. Install Node 18 or newer from https://nodejs.org`); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  const ytdlpKnown = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", path.join(HOME, ".local/bin/yt-dlp")];
  if (has("yt-dlp") || ytdlpKnown.some((p) => fs.existsSync(p))) ok("yt-dlp");
  else {
    try {
      if (process.platform === "darwin" && has("brew")) run("brew", ["install", "yt-dlp"]);
      else if (isWin && has("winget")) run("winget", ["install", "--id", "yt-dlp.yt-dlp", "-e", "--accept-source-agreements", "--accept-package-agreements"]);
      else if (has("pip3")) run("pip3", ["install", "--user", "yt-dlp"]);
      else throw new Error("no installer");
      ok("yt-dlp installed");
    } catch {
      warn("Install yt-dlp yourself (https://github.com/yt-dlp/yt-dlp#installation), then re-run this.");
    }
  }

  step("2. Installing the servers");
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], path.join(KIT, "youtube-study-mcp"));
  ok("youtube-study-mcp");
  if (brightspaceUrl) {
    const dir = path.join(KIT, "brightspace-mcp");
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
    run("npm", ["run", "build", "--silent"], dir);
    const chrome = [
      "/Applications/Google Chrome.app", path.join(HOME, "Applications/Google Chrome.app"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      "/usr/bin/google-chrome", "/usr/bin/chromium",
    ].some((p) => fs.existsSync(p));
    if (!chrome) run("npx", ["playwright", "install", "chromium"], dir);
    ok(`brightspace-mcp for ${brightspaceUrl}`);
  }
}

step(uninstall ? "Removing from your AI apps" : "3. Adding to your AI apps");
writeClaudeDesktop(uninstall);
writeClaudeCode(uninstall);
writeCodex(uninstall);
copySkill(uninstall);

if (uninstall) {
  console.log("\nDone. Your saved video runs are still in ~/StudyVideos.");
} else {
  console.log(`
Done. Quit and reopen your AI app, then ask:

  "Make me a study video run for <course or topic>${brightspaceUrl ? " using my Brightspace course" : ""}."
${brightspaceUrl ? "\nThe first Brightspace request opens a browser window. Sign in the way you normally do,\nincluding any 2FA. The session is saved, so you won't be asked again for a while.\n" : ""}
Video runs are saved in ${path.join(HOME, "StudyVideos")}.`);
}
