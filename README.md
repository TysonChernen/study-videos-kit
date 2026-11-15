# Study Videos Kit

Turn "I have a test next week" into one page that plays only the useful minutes of several YouTube videos, back to back, with practice questions between topics.

Your AI app reads what's on the test (from Brightspace or your slides), searches YouTube, reads each video's transcript to find the exact minutes that cover your material, and builds the page. Every timestamp comes from a transcript, never a guess.

Works with **Claude Desktop**, **Claude Code** and **ChatGPT desktop** (through its Codex MCP settings). No API keys and no GitHub account needed.

## What's inside

| Part | What it does |
| --- | --- |
| `youtube-study-mcp/` | MCP server: `search_videos`, `get_video_info`, `get_transcript`, `build_video_page`, `open_video_page`, `study_videos_guide`. Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), so no YouTube API key. |
| `brightspace-mcp/` | Optional MCP server for any school on D2L Brightspace (Queen's onQ, Western OWL, UVic and so on): courses, content and slides, announcements, assignments, due dates, grades. |
| `skills/study-videos/` | The workflow: find what's tested, search, check transcripts, build. Claude Code and Codex load it as a skill. Every other app gets it from the `study_videos_guide` tool. |
| `install.mjs` | One installer for Mac, Windows and Linux. Finds your AI apps and registers the servers with each one. |

## Install

You need [Node.js 18+](https://nodejs.org). The installer adds yt-dlp if it's missing.

**Option A: let your AI do it.** Paste this into Claude Code, the Code tab in Claude Desktop, or Codex in ChatGPT desktop:

> Install https://github.com/TysonChernen/study-videos-kit: clone it to ~/study-videos-kit and run `node install.mjs` from that folder. My school's Brightspace is `<the address you see when you log in>` (skip this part if your school doesn't use Brightspace).

**Option B: one terminal command.**

```bash
git clone https://github.com/TysonChernen/study-videos-kit ~/study-videos-kit && node ~/study-videos-kit/install.mjs
```

To include Brightspace, add `--brightspace` with your school's address:

```bash
node ~/study-videos-kit/install.mjs --brightspace https://learn.myschool.edu
```

No git? [Download the zip](https://github.com/TysonChernen/study-videos-kit/archive/refs/heads/main.zip), unzip it, and run `node install.mjs` inside the folder.

Then **quit and reopen your AI app**.

> **ChatGPT desktop:** local MCP servers load through Codex, which keeps its settings in `~/.codex/config.toml`. If you've never opened Codex, run the installer with `--codex` to create that file. Regular ChatGPT chat on the web can't run local servers.

## Use it

Ask:

> Make me a study video run for my CHEM 112 midterm 2 using my Brightspace course.

> I have a quiz on eigenvalues and diagonalization Friday. Here are the slides. Find me the parts of videos I should watch.

You get a page that:

- plays each chosen segment and moves on to the next,
- shows a note under each video (for example "your prof uses a different sign convention"),
- pauses at the end of each topic for practice questions,
- saves your progress and playback speed.

Pages are saved in `~/StudyVideos`. To open one later, ask your AI to "open my chem-midterm2 video run", or run:

```bash
node ~/study-videos-kit/youtube-study-mcp/server.mjs open chem-midterm2
```

## Brightspace sign-in, with any 2FA

The first time the AI reads your courses, a Chrome window opens on your school's Brightspace login page. **You sign in yourself**, however your school does it: Microsoft, Google, Okta, Duo push, a texted code, an authenticator app or a security key. Once you're back on Brightspace, the window closes and the session is saved in `~/.brightspace-mcp`, so you won't be asked again for a while.

Your password never passes through the server or the AI. If your school signs in through Microsoft, the server clicks "Not now" on the "add a better way to verify" prompt and "Yes" on "Stay signed in?" for you.

Optional extras, for Microsoft sign-in only. Add them to the `brightspace` server's `env` in your app's MCP config:

| Setting | Effect |
| --- | --- |
| `BRIGHTSPACE_EMAIL`, `BRIGHTSPACE_PASSWORD` | Fills in the Microsoft sign-in form. These are stored in plain text in your config, so only use this on your own computer. |
| `BRIGHTSPACE_READ_SMS=1` | Mac only: reads a texted 2FA code from Messages. Needs Full Disk Access for your AI app. |

Use it for your own studying, within your school's rules.

## Make it yours

The workflow is plain text in `skills/study-videos/SKILL.md`. Edit it and the AI follows the new version. Some ideas:

- Write 3 quiz questions after every segment instead of every topic, from your slides, with an answer key on the last page.
- Pull more from your practice test: one video segment per question type.
- Change the look of the page in `youtube-study-mcp/template.html`.
- Point it at a different source than Brightspace. Any MCP server that gives the AI your course material works.

`examples/hashing-heaps.json` is a sample run. To build it:

```bash
node ~/study-videos-kit/youtube-study-mcp/server.mjs build ~/study-videos-kit/examples/hashing-heaps.json
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Video shows "Error 153" | The page was opened as a file. Open it through your AI or the `open` command above. |
| `yt-dlp not found` | Install it (`brew install yt-dlp`, `winget install yt-dlp`, or `pip install yt-dlp`), then restart the app. |
| Transcript errors with HTTP 429 | YouTube is rate-limiting. Wait a minute. |
| Brightspace tools give 404 | Ask the AI to run `check_api_versions`, then set `BRIGHTSPACE_LP_VERSION` / `BRIGHTSPACE_LE_VERSION` in the server's env. |
| Tools don't show up | Quit the app completely and reopen it. Re-running `node install.mjs` is safe. |

## Uninstall

```bash
node ~/study-videos-kit/install.mjs --uninstall
```

This removes the servers from your apps. Your pages stay in `~/StudyVideos`, and you can delete the folder afterwards.

## License

MIT
