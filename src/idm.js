// Talk to Internet Download Manager, and work out when a download has finished.
//
// Arguments are always passed as an array, never as a joined string: paste
// content is untrusted and would otherwise be able to inject extra IDM switches.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const IDM_CANDIDATES = [
  'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
  'C:\\Program Files\\Internet Download Manager\\IDMan.exe',
];

const IDM_REG_KEY = 'HKCU\\Software\\DownloadManager';

export class IdmError extends Error {}

/** Locate IDMan.exe, or throw with a readable message. */
export function findIdm(override) {
  const tried = override ? [override] : IDM_CANDIDATES;
  for (const candidate of tried) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new IdmError(
    `IDMan.exe not found. Install IDM, or pass --idm "<full path to IDMan.exe>". Looked in:\n  ${tried.join('\n  ')}`,
  );
}

/** Read one registry value. Returns null when the value is absent. */
async function readRegValue(key, name) {
  try {
    const { stdout } = await run('reg.exe', ['query', key, '/v', name]);
    const match = stdout.match(/REG_\w+\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * IDM keeps its own cap on simultaneous downloads, but stores it inside an
 * opaque binary blob under the Queue subkey, so it cannot be read reliably.
 * We only confirm IDM's settings exist, and warn the user to check the cap
 * themselves — if theirs is lower, our extra jobs simply wait in IDM's queue.
 */
export async function idmSettingsPresent() {
  return (await readRegValue(IDM_REG_KEY, 'ExePath')) !== null;
}

/**
 * Total bytes IDM is holding in its partial-download area.
 *
 * IDM does not write into the target folder until a download finishes, so this
 * is the only cheap way to ask "is IDM still moving bytes?". Scanning a folder
 * tree is not free, so callers must only use this when a file already looks
 * stuck — never on the normal poll tick.
 *
 * Returns null when the folder cannot be located or read.
 */
export async function idmTempBytes() {
  const appData = await readRegValue(IDM_REG_KEY, 'AppDataIDMFolder');
  const roots = [
    appData && path.join(appData, 'DwnlData'),
    path.join(process.env.APPDATA ?? '', 'IDM', 'DwnlData'),
  ].filter(Boolean);

  for (const root of roots) {
    if (fs.existsSync(root)) return sumTree(root);
  }
  return null;
}

function sumTree(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += sumTree(full);
      else total += fs.statSync(full).size;
    } catch {
      // a temp file can vanish mid-scan; skip it
    }
  }
  return total;
}

/** True when the finished file is already sitting on disk at its full size. */
export function isCompleteOnDisk(dir, filename, size) {
  if (!size) return false;
  const target = path.join(dir, filename);
  try {
    return fs.statSync(target).size === size;
  } catch {
    return false;
  }
}

async function isIdmRunning() {
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq IDMan.exe']);
    return stdout.includes('IDMan.exe');
  } catch {
    return false;
  }
}

/**
 * Make sure IDM is already open before we queue anything.
 *
 * This matters more than it looks. When IDM is not running, "IDMan.exe /d ..."
 * does not hand a job to IDM and exit — it *becomes* the IDM application and
 * never returns, so the queueing call would hang and then be killed, taking
 * IDM with it. Against a running instance the same call returns in about
 * 300 ms. Returns true if we had to start IDM.
 */
export async function ensureIdmRunning(idmExe) {
  if (await isIdmRunning()) return false;

  spawn(idmExe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isIdmRunning()) return true;
  }
  throw new IdmError('IDM would not start. Open Internet Download Manager, then try again.');
}

/** Add one file to IDM's queue without starting it. */
export async function enqueue(idmExe, { url, filename, dir, referer, userAgent }) {
  const args = ['/d', url, '/p', dir, '/f', filename, '/n', '/a'];
  // IDM only accepts these when the values are non-empty.
  if (referer) args.push('/r', referer);
  if (userAgent) args.push('/u', userAgent);

  try {
    await run(idmExe, args, { windowsHide: true, timeout: 30000 });
  } catch (err) {
    throw new IdmError(`could not queue "${filename}": ${err.message}`);
  }
}

/** Tell IDM to start working through its queue. */
export async function startQueue(idmExe) {
  try {
    await run(idmExe, ['/s'], { windowsHide: true, timeout: 30000 });
  } catch (err) {
    throw new IdmError(`could not start IDM queue: ${err.message}`);
  }
}

/**
 * Decide whether a queued file is finished, still moving, or stuck.
 *
 * Primary signal is the file on disk compared against the exact size the
 * storage node reported. That is version-independent: it does not depend on
 * IDM's undocumented registry layout or temp-file naming.
 *
 * Returns 'done' | 'running' | 'stalled' | 'missing'.
 */
export function checkProgress(item, { stallMs = 30 * 60 * 1000 } = {}) {
  const target = path.join(item.dir, item.filename);

  let bytes = 0;
  if (fs.existsSync(target)) {
    bytes = fs.statSync(target).size;
  } else if (!hasPartialFile(item)) {
    // Nothing on disk yet. That is normal right after queueing.
    return { state: 'missing', bytes: 0 };
  }

  if (item.size && bytes >= item.size) return { state: 'done', bytes };

  // Without a known size, treat "file exists and stopped growing" as done.
  if (!item.size && bytes > 0 && bytes === item.lastBytes) {
    if (Date.now() - (item.lastChangeAt ?? 0) > 15000) {
      return { state: 'done', bytes };
    }
  }

  if (bytes !== item.lastBytes) return { state: 'running', bytes };
  if (Date.now() - (item.lastChangeAt ?? Date.now()) > stallMs) {
    return { state: 'stalled', bytes };
  }
  return { state: 'running', bytes };
}

/** IDM writes partial data next to the target with a temp suffix. */
function hasPartialFile(item) {
  const base = path.join(item.dir, item.filename);
  return ['.idm', '.tmp', '.part'].some((ext) => fs.existsSync(base + ext));
}
