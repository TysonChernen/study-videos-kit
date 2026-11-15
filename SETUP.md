# Setup, step by step

About 3 minutes. **You don't need to install anything first.** The setup gets everything it needs, including a private copy of Node.js if you don't have one. It needs no admin password and doesn't change anything else on your computer.

You need ChatGPT desktop or Claude desktop installed and signed in.

## Mac

1. Open **Terminal**: press `Cmd + Space`, type `Terminal`, press Enter.
2. Paste this and press Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.sh | bash
   ```

   **If your school uses Brightspace**, use this instead, with your school's address (whatever is in your browser's address bar when you're logged in):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.sh | bash -s -- --brightspace https://learn.myschool.edu
   ```

3. Wait for `Done.`
4. **Quit your AI app completely** (`Cmd + Q`, not just closing the window) and open it again.

## Windows

1. Open **PowerShell**: press the Windows key, type `PowerShell`, press Enter.
2. Paste this and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.ps1 | iex
   ```

   **If your school uses Brightspace**, use this instead, with your school's address:

   ```powershell
   $env:BRIGHTSPACE_URL="https://learn.myschool.edu"; irm https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.ps1 | iex
   ```

3. Wait for `Done.`
4. **Quit your AI app completely** (right-click its icon in the taskbar tray and choose Quit) and open it again.

## ChatGPT desktop only

ChatGPT desktop loads these tools through **Codex**. If the setup printed `ChatGPT desktop / Codex config not found`, open Codex in ChatGPT once, then run the setup command again with ` --codex` added at the end. On Mac, that means `... | bash -s -- --codex`.

## Check it worked

Ask your AI app:

> Make me a study video run for photosynthesis.

A page with videos should open in your browser.

## Already have a school MCP connected?

If you already use an MCP server for your school (Brightspace, onQ, Canvas, Moodle or another), leave out `--brightspace`. The AI will read your course from the server you already have.

## Something went wrong?

- **`curl: command not found` (Linux):** install curl with your package manager, then retry.
- **Windows says scripts are disabled:** run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`, then paste the setup line again.
- **The tools don't show up:** quit the app completely and reopen it. Running the setup again is always safe.
- For anything else, see [Troubleshooting](README.md#troubleshooting) in the README.
