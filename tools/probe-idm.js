// Run this once to confirm Automator can drive IDM on this machine.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findIdm, idmSettingsPresent } from '../src/idm.js';

const run = promisify(execFile);
const KEY = 'HKCU\\Software\\DownloadManager';

try {
  console.log('IDMan.exe      :', findIdm(process.argv[2]));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log('IDM settings   :', (await idmSettingsPresent()) ? 'found' : 'missing');

console.log(`\n--- values under ${KEY} ---`);
try {
  const { stdout } = await run('reg.exe', ['query', KEY]);
  console.log(stdout.trim().split('\n').slice(0, 25).join('\n'));
} catch {
  console.log('(key not present — open IDM once, then run this again)');
}
