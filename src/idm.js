// Talk to Internet Download Manager, and work out when a download has finished.
//
// Arguments are always passed as an array, never as a joined string: paste
// content is untrusted and would otherwise be able to inject extra IDM switches.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
