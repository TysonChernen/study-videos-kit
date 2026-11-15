#!/usr/bin/env node
// youtube-study-mcp: find YouTube videos, read their transcripts, and build a
// local study page that plays only the chosen minutes of each video back to back.
// No API key: search, metadata and captions all come from yt-dlp.
//
// MCP mode (default):   node server.mjs
// Command line:         node server.mjs open <name>     serve and open a built page
//                       node server.mjs build <spec.json>
//                       node server.mjs list

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = process.env.STUDY_VIDEOS_DIR || path.join(os.homedir(), "StudyVideos");
const PORT = Number(process.env.STUDY_VIDEOS_PORT || 8235);
const GUIDE_FILE = path.join(HERE, "..", "skills", "study-videos", "SKILL.md");

// MCP servers often start with a minimal PATH, so look for yt-dlp in the usual places.
function findYtDlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(HERE, "..", ".runtime", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    path.join(os.homedir(), ".local/bin/yt-dlp"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || "yt-dlp";
}
const YTDLP = findYtDlp();

// Accepts a full URL, a youtu.be link, a shorts link, or a bare 11-character video ID.
function toUrl(video) {
  const v = String(video).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return `https://www.youtube.com/watch?v=${v}`;
  return v;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          return reject(new Error("yt-dlp not found. Install it (Mac: `brew install yt-dlp`, Windows: `winget install yt-dlp`, any OS: `pip install yt-dlp`) or set YTDLP_PATH."));
        }
        const msg = (stderr || err.message || "").split("\n").filter((l) => l.startsWith("ERROR")).join("\n");
        return reject(new Error(msg || err.message));
      }
      resolve(stdout);
    });
  });
}

async function getInfo(video) {
  const out = await runYtDlp(["-J", "--skip-download", "--no-warnings", "--no-playlist", toUrl(video)]);
  return JSON.parse(out);
}

// "m:ss", "h:mm:ss" or plain seconds -> seconds.
function parseTime(t) {
  if (t === undefined || t === null || t === "") return null;
  if (typeof t === "number") return t;
  const parts = String(t).trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Bad time "${t}". Use seconds or m:ss.`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Pick one VTT caption track. Creator-uploaded captions beat auto-generated ones.
function pickTrack(info, lang) {
  const base = lang.toLowerCase();
  const matchKeys = (dict) => {
    const keys = Object.keys(dict || {});
    return [
      ...keys.filter((k) => k.toLowerCase() === base),
      ...keys.filter((k) => k.toLowerCase().startsWith(base + "-") && !k.endsWith("-orig")),
      ...keys.filter((k) => k.toLowerCase() === base + "-orig"),
    ];
  };
  for (const [kind, dict] of [["manual", info.subtitles], ["auto-generated", info.automatic_captions]]) {
    for (const key of matchKeys(dict)) {
      const vtt = (dict[key] || []).find((f) => f.ext === "vtt");
      if (vtt) return { kind, key, url: vtt.url };
    }
  }
  return null;
}

// Parse WebVTT into [{start, text}], removing inline tags and the duplicated
// rolling lines that auto-generated captions repeat from one cue to the next.
function parseVtt(vtt) {
  const cues = [];
  const recent = [];
  let start = null;
  for (const raw of vtt.split(/\r?\n/)) {
    const m = raw.match(/^(\d+):(\d{2}):(\d{2})\.\d+\s+-->/) || raw.match(/^(\d{2}):(\d{2})\.\d+\s+-->/);
    if (m) {
      start = m.length === 4 ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
      continue;
    }
    if (start === null) continue;
    const text = raw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&nbsp;/g, " ").trim();
    if (!text || /^\d+$/.test(text) || recent.includes(text)) continue;
    cues.push({ start, text });
    recent.push(text);
    if (recent.length > 3) recent.shift();
  }
  return cues;
}

// Merge cues into chunks of roughly `chunkSeconds`, each stamped with its start time.
function chunk(cues, chunkSeconds) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur || c.start - cur.start >= chunkSeconds) {
      if (cur) out.push(cur);
      cur = { start: c.start, parts: [c.text] };
    } else {
      cur.parts.push(c.text);
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => `[${fmtTime(c.start)}] ${c.parts.join(" ")}`).join("\n");
}

function header(info) {
  const lines = [
    `Title: ${info.title}`,
    `Channel: ${info.channel || info.uploader || "unknown"}`,
    `Length: ${fmtTime(info.duration || 0)}`,
    `URL: ${info.webpage_url}`,
  ];
  if (info.chapters?.length) {
    lines.push("Chapters:");
    for (const ch of info.chapters) lines.push(`  ${fmtTime(ch.start_time)} ${ch.title}`);
  }
  return lines.join("\n");
}

async function getTranscript({ video, lang = "en", start, end, chunk_seconds = 20 }) {
  const info = await getInfo(video);
  const track = pickTrack(info, lang);
  if (!track) {
    const avail = [...Object.keys(info.subtitles || {}), ...Object.keys(info.automatic_captions || {}).slice(0, 10)];
    return `${header(info)}\n\nNo "${lang}" captions found. Available: ${avail.join(", ") || "none"}.`;
  }
  const res = await fetch(track.url);
  if (res.status === 429) throw new Error("YouTube rate-limited the caption request (429). Wait a minute and try again.");
  if (!res.ok) throw new Error(`Caption download failed: HTTP ${res.status}`);
  let cues = parseVtt(await res.text());
  const s = parseTime(start);
  const e = parseTime(end);
  if (s !== null) cues = cues.filter((c) => c.start >= s);
  if (e !== null) cues = cues.filter((c) => c.start <= e);
  const range = s !== null || e !== null ? ` (${fmtTime(s ?? 0)}–${fmtTime(e ?? info.duration ?? 0)})` : "";
  return `${header(info)}\nCaptions: ${track.kind} [${track.key}]${range}\n\n${chunk(cues, Math.max(1, chunk_seconds)) || "(no captions in that range)"}`;
}

async function getVideoInfo({ video }) {
  const info = await getInfo(video);
  const manual = Object.keys(info.subtitles || {});
  const auto = Object.keys(info.automatic_captions || {});
  return `${header(info)}\nManual captions: ${manual.join(", ") || "none"}\nAuto captions: ${auto.includes("en") ? "en available" : auto.length ? "available (no en)" : "none"}`;
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function searchVideos({ query, limit = 8 }) {
  if (!query) throw new Error("query is required");
  const n = Math.min(Math.max(1, Number(limit) || 8), 20);
  const out = await runYtDlp(["-J", "--flat-playlist", "--no-warnings", `ytsearch${n}:${query}`]);
  const entries = JSON.parse(out).entries || [];
  if (!entries.length) return `No results for "${query}".`;
  return entries.map((e, i) => {
    const views = e.view_count ? ` · ${Number(e.view_count).toLocaleString("en-US")} views` : "";
    return `${i + 1}. ${e.title}\n   ${e.channel || e.uploader || "unknown"} · ${fmtTime(e.duration || 0)}${views}\n   id: ${e.id}`;
  }).join("\n");
}

// ─── Study pages ─────────────────────────────────────────────────────────────

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video-run";

function videoId(v) {
  const s = String(v).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    let cand = "";
    if (u.hostname.includes("youtu.be")) cand = u.pathname.split("/")[1] || "";
    else if (u.hostname.includes("youtube")) cand = u.searchParams.get("v") || u.pathname.replace(/\/$/, "").split("/").pop();
    if (/^[A-Za-z0-9_-]{11}$/.test(cand)) return cand;
  } catch { /* fall through */ }
  throw new Error(`cannot find a YouTube video ID in "${s}"`);
}

const pageUrl = (name) => `http://localhost:${PORT}/${encodeURIComponent(name)}.html`;
const PING_URL = `http://localhost:${PORT}/_ping.js`;

function openHint(name) {
  return `Ask your AI app to "open my ${name} video run", or run: node "${path.join(HERE, "server.mjs")}" open ${name}`;
}

function buildPage(spec) {
  const title = spec.title || "Video run";
  const name = slug(spec.name || title);
  const raw = spec.segments;
  if (!Array.isArray(raw) || !raw.length) throw new Error("segments must be a non-empty list");
  const segments = raw.map((s, n) => {
    const where = `segment ${n + 1}`;
    for (const k of ["topic", "video", "start", "end", "title"]) {
      if (s[k] === undefined || s[k] === null || s[k] === "") throw new Error(`${where} is missing '${k}'`);
    }
    const start = parseTime(s.start), end = parseTime(s.end);
    if (!(end > start)) throw new Error(`${where} (${s.title}): end ${s.end} is not after start ${s.start}`);
    const seg = { topic: String(s.topic), id: videoId(s.video), start: Math.floor(start), end: Math.floor(end), title: String(s.title) };
    if (s.note) seg.note = String(s.note);
    if (s.check) seg.check = String(s.check);
    return seg;
  });

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const specPath = path.join(PAGES_DIR, `${name}.json`);
  fs.writeFileSync(specPath, JSON.stringify({ name, title, segments: raw }, null, 2) + "\n");

  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const vals = {
    __TITLE__: esc(title),
    __SPEC__: `${name}.json`,
    __TITLE_JSON__: JSON.stringify(title),
    __SERVED_URL_JSON__: JSON.stringify(pageUrl(name)),
    __PING_URL_JSON__: JSON.stringify(PING_URL),
    __LAUNCHER_JSON__: JSON.stringify(openHint(name)),
    __STORE_JSON__: JSON.stringify(`study-videos:${name}`),
    __SEGMENTS_JSON__: JSON.stringify(segments, null, 2),
  };
  let html = fs.readFileSync(path.join(HERE, "template.html"), "utf8");
  for (const [k, v] of Object.entries(vals)) html = html.split(k).join(v);
  const out = path.join(PAGES_DIR, `${name}.html`);
  fs.writeFileSync(out, html);

  const total = segments.reduce((a, s) => a + s.end - s.start, 0);
  return { name, out, specPath, segments, total };
}

// A tiny static server for PAGES_DIR. YouTube embeds refuse to play on file:// pages.
let httpServer = null;
async function pingServer() {
  try { const r = await fetch(PING_URL); return r.ok; } catch { return false; }
}
async function ensureServer() {
  if (httpServer) return;
  if (await pingServer()) return; // another copy of this server is already serving
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/_ping.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end("window.__studyVideosServerUp = true;\n");
    }
    if (p === "/") {
      const pages = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><title>Study videos</title><body style="font:16px sans-serif;padding:30px"><h2>Study video runs</h2>` +
        pages.map((f) => `<p><a href="/${encodeURIComponent(f)}">${f.replace(/\.html$/, "").replace(/</g, "&lt;")}</a></p>`).join("") + `</body>`);
    }
    const file = path.join(PAGES_DIR, path.normalize(p).replace(/^([/\\])+/, ""));
    if (!file.startsWith(PAGES_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(PORT, "127.0.0.1", resolve);
  }).catch(async (err) => {
    if (err.code === "EADDRINUSE" && await pingServer()) return;
    throw new Error(err.code === "EADDRINUSE"
      ? `Port ${PORT} is used by another program. Set STUDY_VIDEOS_PORT to a free port in the MCP config.`
      : err.message);
  });
  if (srv.listening) { srv.unref(); httpServer = srv; }
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

function listPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
}

async function buildTool(args) {
  const r = buildPage(args);
  await ensureServer();
  const opened = args.open === false ? false : openInBrowser(pageUrl(r.name));
  const byTopic = [];
  for (const s of r.segments) {
    const last = byTopic[byTopic.length - 1];
    if (last && last.topic === s.topic) last.n++; else byTopic.push({ topic: s.topic, n: 1 });
  }
  return [
    `Built "${r.name}": ${r.segments.length} segments, ${fmtTime(r.total)} at 1x, ${fmtTime(Math.round(r.total / 1.5))} at 1.5x.`,
    `Topics: ${byTopic.map((t) => `${t.topic} (${t.n})`).join(", ")}`,
    `URL: ${pageUrl(r.name)}${opened ? " (opened in the browser)" : ""}`,
    `Page: ${r.out}`,
    `Spec: ${r.specPath} (to change the run, edit this and call build_video_page again)`,
    `The page plays while this app is open. Later: ${openHint(r.name)}`,
  ].join("\n");
}

async function openTool({ name }) {
  const pages = listPages();
  if (!name) return pages.length ? `Saved video runs: ${pages.join(", ")}` : "No video runs built yet.";
  const match = pages.find((p) => p === slug(name)) || pages.find((p) => p.includes(slug(name)));
  if (!match) return `No video run called "${name}". Saved runs: ${pages.join(", ") || "none"}.`;
  await ensureServer();
  openInBrowser(pageUrl(match));
  return `Opened ${pageUrl(match)}`;
}

function guide() {
  try {
    return fs.readFileSync(GUIDE_FILE, "utf8").replace(/^---[\s\S]*?---\s*/, "");
  } catch {
    return "Guide file not found. Workflow: find what will be tested, search videos, read transcripts to pick exact minutes, then call build_video_page.";
  }
}

// ─── MCP server ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "study_videos_guide",
    description: "Read this FIRST when the user asks for study videos, a video playlist, a watch list, or which parts of a video to watch. Returns the step-by-step workflow for building a study video run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_videos",
    description: "Search YouTube. Returns title, channel, length, views and video ID for each result. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms, e.g. 'double hashing worked example'" },
        limit: { type: "number", description: "Number of results, 1-20 (default 8)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_video_info",
    description: "Get a YouTube video's title, channel, length, chapter list and caption languages, without the transcript.",
    inputSchema: {
      type: "object",
      properties: { video: { type: "string", description: "YouTube URL or 11-character video ID" } },
      required: ["video"],
    },
  },
  {
    name: "get_transcript",
    description:
      "Get a YouTube video's transcript as timestamped text, plus title, length and chapters. Prefers the creator's captions over auto-generated ones. " +
      "Use start/end to read only part of a video and chunk_seconds (e.g. 40) to keep it compact.",
    inputSchema: {
      type: "object",
      properties: {
        video: { type: "string", description: "YouTube URL or 11-character video ID" },
        lang: { type: "string", description: "Caption language code (default: en)" },
        start: { type: "string", description: "Optional start time, seconds or m:ss" },
        end: { type: "string", description: "Optional end time, seconds or m:ss" },
        chunk_seconds: { type: "number", description: "Group captions into blocks of about this many seconds (default: 20)" },
      },
      required: ["video"],
    },
  },
  {
    name: "build_video_page",
    description:
      "Build (or rebuild) a study page that plays the chosen segments of several YouTube videos back to back, with a note under each and a paper exercise when a topic ends. " +
      "Saves it to the StudyVideos folder, serves it locally and opens it in the browser. Only use timestamps you checked in a transcript or chapter list.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title, e.g. 'Biology Midterm 2 - Video Run'" },
        name: { type: "string", description: "Short file name, e.g. 'bio-midterm2'. Reusing a name replaces that run." },
        open: { type: "boolean", description: "Open in the browser when built (default true)" },
        segments: {
          type: "array",
          description: "In study order.",
          items: {
            type: "object",
            properties: {
              topic: { type: "string", description: "Topic heading, shared by consecutive segments" },
              video: { type: "string", description: "Video ID or URL" },
              start: { type: "string", description: "m:ss, h:mm:ss or seconds" },
              end: { type: "string", description: "m:ss, h:mm:ss or seconds" },
              title: { type: "string", description: "What this segment teaches" },
              note: { type: "string", description: "Optional. Shown while it plays: how it differs from the course, what to watch for" },
              check: { type: "string", description: "Optional, usually on the last segment of a topic. Exercise or quiz questions shown when it ends (playback pauses). No answers." },
            },
            required: ["topic", "video", "start", "end", "title"],
          },
        },
      },
      required: ["title", "segments"],
    },
  },
  {
    name: "open_video_page",
    description: "Open a video run built earlier, by name. With no name, lists the saved runs.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
];

const HANDLERS = {
  study_videos_guide: async () => guide(),
  search_videos: searchVideos,
  get_video_info: getVideoInfo,
  get_transcript: getTranscript,
  build_video_page: buildTool,
  open_video_page: openTool,
};

async function runMcp() {
  const server = new Server(
    { name: "youtube-study", version: "1.0.0" },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        "Builds YouTube study video runs. When the user wants videos for a course, test or topic, call study_videos_guide first and follow it: " +
        "work out what is tested, search_videos, verify with get_transcript, then build_video_page.",
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const fn = HANDLERS[name];
      if (!fn) throw new Error(`Unknown tool: ${name}`);
      return { content: [{ type: "text", text: await fn(args) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: "study_videos",
      description: "Build a study video run for a course, test or topic",
      arguments: [{ name: "goal", description: "e.g. 'CHEM 112 midterm 2' or 'eigenvalues'", required: true }],
    }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
    messages: [{
      role: "user",
      content: { type: "text", text: `Build me a study video run for: ${req.params.arguments?.goal ?? "my next test"}\n\nFollow this workflow:\n\n${guide()}` },
    }],
  }));
  await server.connect(new StdioServerTransport());
}

// ─── Command line ────────────────────────────────────────────────────────────

const [cmd, arg] = process.argv.slice(2);
if (!cmd) {
  await runMcp();
} else if (cmd === "open") {
  console.log(await openTool({ name: arg }));
  if (httpServer) { httpServer.ref(); console.log("Serving. Press Ctrl+C to stop."); }
} else if (cmd === "build") {
  if (!arg) { console.error("usage: node server.mjs build <spec.json>"); process.exit(1); }
  console.log(await buildTool(JSON.parse(fs.readFileSync(arg, "utf8"))));
  if (httpServer) { httpServer.ref(); console.log("Serving. Press Ctrl+C to stop."); }
} else if (cmd === "list") {
  console.log(listPages().join("\n") || "No video runs built yet.");
} else {
  console.error("usage: node server.mjs [open <name> | build <spec.json> | list]");
  process.exit(1);
}
