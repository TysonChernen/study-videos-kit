import * as os from 'os';
import * as path from 'path';

// Your school's Brightspace (D2L) address, e.g. https://learn.myschool.edu
// Set BRIGHTSPACE_URL in the MCP config. No trailing slash.
const raw = process.env.BRIGHTSPACE_URL ?? '';
if (!raw) {
  console.error('BRIGHTSPACE_URL is not set. Add it to this server\'s env in your MCP config, e.g. https://learn.myschool.edu');
}
export const ONQ_HOST = raw.replace(/\/+$/, '');
export const HOST_NAME = (() => { try { return new URL(ONQ_HOST).hostname; } catch { return ''; } })();

// Where session cookies are stored on disk
export const SESSION_DIR = path.join(os.homedir(), '.brightspace-mcp');
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

// Persistent browser profile, keeps SSO "remember me" cookies across sessions
export const BROWSER_DATA_DIR = path.join(SESSION_DIR, 'browser-data');

// Files downloaded from course content (slides, PDFs) are saved here
export const DOWNLOADS_DIR = process.env.BRIGHTSPACE_DOWNLOADS ?? path.join(os.homedir(), 'Downloads', 'brightspace-files');

// How often to ping D2L to keep the session alive (15 minutes)
export const KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000;

// How long to wait for you to finish signing in, including any 2FA (5 minutes)
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// D2L REST API versions. If you get 404 errors, run the check_api_versions tool
// and set BRIGHTSPACE_LP_VERSION / BRIGHTSPACE_LE_VERSION.
export const LP_VERSION = process.env.BRIGHTSPACE_LP_VERSION ?? '1.57';
export const LE_VERSION = process.env.BRIGHTSPACE_LE_VERSION ?? '1.92';
