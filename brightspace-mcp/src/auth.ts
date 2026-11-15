/**
 * auth.ts
 * Signs in to your school's Brightspace and saves the session cookies.
 *
 * Works with any school and any sign-in or 2FA method, because YOU do the
 * sign-in: a real Chrome window opens on your Brightspace login page, you sign
 * in however your school asks (Microsoft, Google, Okta, Duo, SMS, an
 * authenticator app, a security key...), and the server saves the cookies once
 * the browser lands back on Brightspace. Your password is never seen.
 *
 * Optional extras for Microsoft (Entra ID) schools only:
 *  - BRIGHTSPACE_EMAIL + BRIGHTSPACE_PASSWORD: fill in the Microsoft sign-in form.
 *  - BRIGHTSPACE_READ_SMS=1 (macOS only): read a texted 2FA code from the
 *    Messages database. Needs Full Disk Access for the app that runs the server.
 * Microsoft's "add a better way to verify" page is skipped (Not now) and
 * "Stay signed in?" is answered Yes automatically.
 *
 * If Google Chrome is not installed, Playwright's bundled Chromium is used
 * (run `npx playwright install chromium` once).
 */

import { chromium, type Cookie, type BrowserContext, type Browser, type Page } from 'playwright';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import { SESSION_DIR, SESSION_FILE, BROWSER_DATA_DIR, ONQ_HOST, HOST_NAME, LOGIN_TIMEOUT_MS } from './config.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];
const CHROME_PATH = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? '';
const CHROME_DATA_DIR = path.join(SESSION_DIR, 'chrome-data');

/** True once the browser is back on a signed-in Brightspace page. */
function isSignedInUrl(href: string): boolean {
  return href.startsWith(ONQ_HOST) && !href.includes('/d2l/login') && !href.includes('/d2l/lp/auth');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredSession {
  cookies: Cookie[];
  savedAt: string;
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

export function loadSession(): StoredSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // Ignore errors during cleanup
  }
  // Keep browser-data/ and chrome-data/ intact — they hold SSO "remember me"
  // tokens that let Microsoft skip the login page entirely.
}

// ─── Cookie utilities ─────────────────────────────────────────────────────────

export function cookiesToHeader(cookies: Cookie[]): string {
  return cookies
    .filter(c => { const d = c.domain.replace(/^\./, ''); return HOST_NAME === d || HOST_NAME.endsWith('.' + d); })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ─── Chrome CDP helpers ───────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForCDP(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`CDP status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Chrome did not start in time');
}

/**
 * Read the latest 2FA verification code from macOS Messages (chat.db).
 * Only returns codes received after `afterMs` (unix milliseconds).
 * Returns null if chat.db is unreadable or no code found.
 */
async function readLatest2FACode(afterMs: number): Promise<string | null> {
  if (process.env.BRIGHTSPACE_READ_SMS !== '1' || process.platform !== 'darwin') return null;
  const chatDbPath = path.join(process.env.HOME ?? '', 'Library/Messages/chat.db');
  if (!fs.existsSync(chatDbPath)) return null;

  try {
    const APPLE_EPOCH_OFFSET = 978307200;
    const appleNanos = Math.floor((afterMs / 1000 - APPLE_EPOCH_OFFSET) * 1e9);

    const mod: any = await import('better-sqlite3' as string).catch(() => null);
    if (!mod) return null;
    const Database = mod.default ?? mod;
    const db = new Database(chatDbPath, { readonly: true });
    const row = db.prepare(
      `SELECT text FROM message WHERE date > ? ` +
      `AND (text LIKE '%verification%' OR text LIKE '%security code%' ` +
      `OR text LIKE '%account%code%' OR text LIKE '%sign%code%' ` +
      `OR text LIKE '%Microsoft%') ` +
      `ORDER BY date DESC LIMIT 1`
    ).get(appleNanos) as { text: string } | undefined;
    db.close();

    if (!row?.text) return null;
    const match = row.text.match(/\b(\d{6,8})\b/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─── Chrome CDP authentication ────────────────────────────────────────────────

async function authenticateWithChrome(creds: { email: string; password: string } | null): Promise<Cookie[]> {
  console.error(
    '\n🔐 Brightspace MCP: a Chrome window is opening on your Brightspace login page.\n' +
    '   Sign in there the way you normally do, including any 2FA. The window closes by itself when you are in.\n'
  );

  if (!fs.existsSync(CHROME_DATA_DIR)) {
    fs.mkdirSync(CHROME_DATA_DIR, { recursive: true, mode: 0o700 });
  }

  // Clean up stale lock file from a previous crash
  const lockFile = path.join(CHROME_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }

  const port = await findFreePort();

  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    `${ONQ_HOST}/d2l/login`,
  ], {
    stdio: 'ignore',
    detached: false,
  });

  let browser: Browser | null = null;

  try {
    logAuth('Waiting for CDP...');
    await waitForCDP(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context found');

    const page = context.pages().find(p => {
      const u = p.url();
      return (HOST_NAME && u.includes(HOST_NAME)) || u.includes('d2l');
    }) ?? context.pages()[0];
    if (!page) throw new Error('No pages found');

    await page.waitForLoadState('domcontentloaded');
    logAuth(`After load: ${page.url()}`);
    if (isSignedInUrl(page.url())) {
      logAuth('Already signed in via saved SSO cookies');
      return await context.cookies();
    }

    // Microsoft's post-2FA prompts are handled on every page load, for manual sign-in too.
    page.on('load', async () => {
      try { if (MICROSOFT_URL.test(page.url())) await handleOnePrompt(page); } catch { /* non-critical */ }
    });

    if (creds) {
      try {
        await page.waitForURL(
          url => MICROSOFT_URL.test(url.toString()) || isSignedInUrl(url.toString()),
          { timeout: 30_000 }
        );
        if (MICROSOFT_URL.test(page.url())) {
          await autoFillMicrosoft(page, creds.email, creds.password);
          await page.waitForTimeout(2_000);
          await handlePostLoginPrompts(page);
        }
      } catch (err) {
        logAuth(`Auto-fill stopped (${err}); finish signing in by hand.`);
      }
    }

    await page.waitForURL(url => isSignedInUrl(url.toString()), { timeout: LOGIN_TIMEOUT_MS });
    await page.waitForTimeout(2_000);
    const cookies = await context.cookies();
    console.error('✅ Signed in to Brightspace.\n');
    return cookies;

  } finally {
    if (browser) await browser.close().catch(() => {});
    chromeProcess.kill();
    try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

const MICROSOFT_URL = /login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|mysignins\.microsoft\.com|aka\.ms\/mfasetup|account\.activedirectory/i;

/** Microsoft (Entra ID) only: fill email and password, pick SMS, and read the code if allowed. */
async function autoFillMicrosoft(page: Page, email: string, password: string): Promise<void> {
    // Wait for the login page to actually render
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2_000);
    logAuth(`Page loaded. URL: ${page.url()}`);

    // Step 1: Email — either type it or pick the saved account
    const emailField = page.locator('input[name="loginfmt"]');
    const accountTile = page.locator(`small:has-text("${email}"), div[data-test-id="${email}"], #tilesHolder div:has-text("${email}")`);

    const emailVisible = await emailField.isVisible({ timeout: 10_000 }).catch(() => false);
    logAuth(`Email field visible: ${emailVisible}`);

    if (emailVisible) {
      await emailField.fill(email);
      await page.locator('#idSIButton9').click();
      logAuth('Email submitted');
      await page.waitForTimeout(2_000);
    } else {
      const tileVisible = await accountTile.first().isVisible({ timeout: 10_000 }).catch(() => false);
      logAuth(`Account tile visible: ${tileVisible}`);
      if (tileVisible) {
        await accountTile.first().click();
        logAuth('Account tile clicked');
        await page.waitForTimeout(3_000);
      } else {
        logAuth('Neither email field nor account tile found');
      }
    }

    // Step 2: Password
    const passwordField = page.locator('input[name="passwd"]');
    const pwVisible = await passwordField.isVisible({ timeout: 10_000 }).catch(() => false);
    logAuth(`Password field visible: ${pwVisible}`);

    if (pwVisible) {
      await passwordField.fill(password);
      await page.locator('#idSIButton9').click();
      logAuth('Password submitted');
      await page.waitForTimeout(3_000);
    }

    // Step 3: 2FA method selection
    logAuth('Looking for SMS option...');
    const smsOption = page.locator('[data-value="OneWaySMS"], [data-value="PhoneAppOTP"], a:has-text("Text"), div:has-text("Text +"):not(:has(div))');
    const smsVisible = await smsOption.first().isVisible({ timeout: 8_000 }).catch(() => false);
    logAuth(`SMS option visible: ${smsVisible}`);
    if (smsVisible) {
      console.error('   Selecting SMS verification...');
      await smsOption.first().click();
      await page.waitForTimeout(2_000);
    }

    const sendCodeBtn = page.locator('#idSubmit_SAOTCS_SendCode, button:has-text("Send"), input[value="Send code"]');
    const sendCodeVisible = await sendCodeBtn.first().isVisible({ timeout: 3_000 }).catch(() => false);
    if (sendCodeVisible) {
      await sendCodeBtn.first().click();
      await page.waitForTimeout(2_000);
    }

    // Step 4: 2FA code entry
    const otcField = page.locator('#idTxtBx_SAOTCC_OTC');
    const otcVisible = await otcField.isVisible({ timeout: 15_000 }).catch(() => false);
    logAuth(`OTC field visible: ${otcVisible}`);

    if (otcVisible) {
      logAuth('Polling Messages for 2FA code...');
      const lookbackMs = Date.now() - 120_000;
      let code: string | null = null;

      for (let i = 0; i < 30; i++) {
        code = await readLatest2FACode(lookbackMs);
        if (code) break;
        if (i === 0) logAuth('First poll returned null, continuing...');
        await page.waitForTimeout(2_000);
      }

      if (code) {
        logAuth(`Found 2FA code: ${code}`);
        await otcField.fill(code);
        await page.locator('#idSubmit_SAOTCC_Continue').click();
        logAuth('2FA submitted');
      } else {
        logAuth('Could not read 2FA from Messages — waiting for manual entry');
        await page.waitForURL(
          url => !url.toString().includes('login.microsoftonline.com'),
          { timeout: LOGIN_TIMEOUT_MS }
        );
      }
    } else {
      const pushPrompt = page.locator('#idDiv_SAOTCAS_Title, #idRichContext_DisplaySign');
      const pushVisible = await pushPrompt.isVisible({ timeout: 3_000 }).catch(() => false);
      logAuth(`Push MFA visible: ${pushVisible}`);

      if (pushVisible) {
        logAuth('Waiting for Authenticator approval...');
        await page.waitForURL(
          url => !url.toString().includes('login.microsoftonline.com'),
          { timeout: LOGIN_TIMEOUT_MS }
        );
      } else {
        logAuth(`No 2FA detected. Current URL: ${page.url()}`);
      }
    }

}

// ─── Prompts Microsoft shows after 2FA ───────────────────────────────────────
//
// Each page is identified by its text before anything is clicked. The
// "add a better way to verify" page puts Next (start setup) on the right as the
// primary #idSIButton9 button and "Not now" on the left, so a blind click on
// #idSIButton9 would start adding a sign-in method instead of skipping it.

const SECURITY_PROMPT_TEXT =
  /better way to verify|keep your account secure|more information required|improve your sign-in|set up another way|add (?:a |another )?(?:sign-in |verification )?method/i;
const SKIP_BUTTONS = [
  '#btnAskLater',
  'button:has-text("Not now")', 'a:has-text("Not now")', 'input[value="Not now"]',
  'button:has-text("Skip for now")', 'a:has-text("Skip for now")', 'input[value="Skip for now"]',
  'button:has-text("Ask later")', 'a:has-text("Ask later")', 'input[value="Ask later"]',
].join(', ');
const KMSI_TEXT = /stay signed in\?/i;

/** Returns which prompt (if any) was handled on this page. */
export async function handleOnePrompt(page: Page): Promise<'skipped-security' | 'accepted-kmsi' | 'none'> {
  const text = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');

  if (SECURITY_PROMPT_TEXT.test(text)) {
    const skip = page.locator(SKIP_BUTTONS).first();
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await skip.click();
      console.error('   ✓ Skipped "add a better way to verify" (Not now).');
      return 'skipped-security';
    }
    logAuth('Security prompt shown but no Not now / Skip button found; leaving it for manual action');
    return 'none';
  }

  if (KMSI_TEXT.test(text) || await page.locator('#KmsiDescription, #KmsiCheckboxField').first().isVisible({ timeout: 500 }).catch(() => false)) {
    const yes = page.locator('#idSIButton9, input[value="Yes"], button:has-text("Yes")').first();
    if (await yes.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await yes.click();
      console.error('   ✓ Auto-accepted "Stay signed in?"');
      return 'accepted-kmsi';
    }
  }
  return 'none';
}

/** Works through the post-2FA prompts until the browser leaves Microsoft's sign-in pages. */
export async function handlePostLoginPrompts(page: Page, maxRounds = 6): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const url = page.url();
    const onMicrosoft = MICROSOFT_URL.test(url);
    if (!onMicrosoft) return;
    const handled = await handleOnePrompt(page);
    logAuth(`Post-login prompt round ${round + 1}: ${handled} (${url})`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(handled === 'none' ? 2_000 : 1_500);
  }
}

// ─── Playwright fallback authentication ───────────────────────────────────────

async function tryAcceptKMSI(context: BrowserContext): Promise<void> {
  context.on('page', (page) => {
    page.on('load', async () => {
      try {
        if (!MICROSOFT_URL.test(page.url())) return;
        await handleOnePrompt(page);
      } catch { /* Non-critical */ }
    });
  });
}

async function authenticateWithPlaywright(): Promise<Cookie[]> {
  console.error(
    '\n🔐 Brightspace MCP needs you to sign in.\n' +
    '   A browser window will open. Sign in the way you normally do, including any 2FA.\n' +
    '   Your credentials are never seen or stored by this server.\n'
  );

  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true, mode: 0o700 });
  }

  // Clean up stale lock file from a previous crash
  const lockFile = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });

  await tryAcceptKMSI(context);

  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(`${ONQ_HOST}/d2l/login`, {
    waitUntil: 'domcontentloaded',
  });

  page.on('load', async () => {
    try {
      if (!MICROSOFT_URL.test(page.url())) return;
      await handleOnePrompt(page);
    } catch { /* Non-critical */ }
  });

  await page.waitForURL((url) => isSignedInUrl(url.toString()), { timeout: LOGIN_TIMEOUT_MS }
  );

  await page.waitForTimeout(2_000);

  const cookies = await context.cookies();
  await context.close();

  console.error('✅ Signed in to Brightspace.\n');
  return cookies;
}

// ─── Main authentication entry point ──────────────────────────────────────────

function loadCredentials(): { email: string; password: string } | null {
  // Optional, Microsoft sign-in only. Leave unset to sign in by hand.
  if (process.env.BRIGHTSPACE_EMAIL && process.env.BRIGHTSPACE_PASSWORD) {
    return { email: process.env.BRIGHTSPACE_EMAIL, password: process.env.BRIGHTSPACE_PASSWORD };
  }
  return null;
}

const AUTH_LOG = path.join(SESSION_DIR, 'auth.log');
function logAuth(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(AUTH_LOG, line); } catch { /* ignore */ }
  console.error(msg);
}

export async function authenticate(): Promise<Cookie[]> {
  if (!ONQ_HOST) throw new Error('BRIGHTSPACE_URL is not set. Add it to this server\'s env in your MCP config (for example https://learn.myschool.edu).');
  const creds = loadCredentials();
  logAuth(`authenticate() called. autofill=${!!creds}, chrome=${!!CHROME_PATH}`);

  if (CHROME_PATH) {
    try {
      return await authenticateWithChrome(creds);
    } catch (err) {
      logAuth(`Chrome sign-in failed: ${err}`);
    }
  }

  logAuth('Falling back to Playwright Chromium...');
  return await authenticateWithPlaywright();
}
