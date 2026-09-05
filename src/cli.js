#!/usr/bin/env node
// Automator — read a paste of download links and drive IDM through them.
//
//   node src/cli.js links   <paste-url>
//   node src/cli.js resolve <page-url>
//   node src/cli.js run     <paste-url> --max 3 --dir "D:\Games"
//   node src/cli.js report  [run-file]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadPaste, PasteError } from './paste.js';
import { RunLog, STATUS, linkId, runLogPath } from './state.js';
import { openBrowser, resolveLink } from './resolve.js';
import {
  findIdm,
  ensureIdmRunning,
  idmSettingsPresent,
  isCompleteOnDisk,
  IdmError,
} from './idm.js';
import { Scheduler } from './queue.js';
import { buildRows, toMarkdown, toCsv } from './report.js';

const STATE_DIR = path.resolve('state');

const USAGE = `
Automator — paste links to IDM

  links   <paste-url>                 decrypt the paste and list the links
  resolve <page-url>                  resolve one link to its direct file URL
  run     <paste-url>                 download everything through IDM
  retry   [run-file]                  redo only the failed files of a past run
  report  [run-file]                  print a table of a finished run

Options for "run" and "retry":
  --max <n>        how many downloads may be active at once   (default 3)
  --dir <path>     where to save files                        (default .\\downloads)
  --idm <path>     full path to IDMan.exe                     (auto-detected)
  --headless       hide the browser window (only after a headed first run)
  --stall <min>    give up after this many idle minutes        (default 30)
  --start-timeout <min>
                   how long to wait for a file to appear before
                   checking whether IDM has gone idle          (default 45)

Options for "run":
  --password <s>   paste password, if the paste has one

Options for "retry":
  --check-only     only compare against the folder, download nothing

Options for "report":
  --csv            print CSV instead of a table
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      max: { type: 'string', default: '3' },
      dir: { type: 'string' },
      idm: { type: 'string' },
      password: { type: 'string', default: '' },
      headless: { type: 'boolean', default: false },
      stall: { type: 'string', default: '30' },
      'start-timeout': { type: 'string', default: '45' },
      'check-only': { type: 'boolean', default: false },
      csv: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'links':
      return cmdLinks(target, values);
    case 'resolve':
      return cmdResolve(target, values);
    case 'run':
      return cmdRun(target, values);
    case 'retry':
      return cmdRetry(target, values);
    case 'report':
      return cmdReport(target, values);
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function cmdLinks(pasteUrl, values) {
  requireArg(pasteUrl, 'links <paste-url>');
  const { links } = await loadPaste(pasteUrl, values.password);
  links.forEach((l, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${l.filename}\n     ${l.url}`);
  });
  console.log(`\n${links.length} links.`);
}

async function cmdResolve(pageUrl, values) {
  requireArg(pageUrl, 'resolve <page-url>');
  const browser = await openBrowser({ headless: values.headless });
  try {
    const out = await resolveLink(browser, pageUrl);
    console.log('url       :', out.url);
    console.log('size      :', formatBytes(out.size));
    console.log('filename  :', out.serverFilename);
    console.log('resumable :', out.resumable);
  } finally {
    await browser.close();
  }
}

/** Shared option checks and IDM setup for the two downloading commands. */
async function prepareDownload(values) {
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1 || max > 32) {
    throw new Error('--max must be a whole number between 1 and 32');
  }
  const stallMs = Number(values.stall) * 60000;
  if (!Number.isFinite(stallMs) || stallMs <= 0) {
    throw new Error('--stall must be a positive number of minutes');
  }
  const startTimeoutMs = Number(values['start-timeout']) * 60000;
  if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0) {
    throw new Error('--start-timeout must be a positive number of minutes');
  }

  const dir = path.resolve(values.dir ?? 'downloads');
  fs.mkdirSync(dir, { recursive: true });

  const idmExe = findIdm(values.idm);
  console.log(`IDM      : ${idmExe}`);
  if (await ensureIdmRunning(idmExe)) console.log('           (started IDM)');
  console.log(`Saving to: ${dir}`);

  if (!(await idmSettingsPresent())) {
    console.warn(
      'warning: IDM settings not found in the registry. Open IDM once before running.',
    );
  } else if (max > 4) {
    console.warn(
      `note: IDM has its own cap on simultaneous downloads. If it is below ${max},\n` +
        '      the extra jobs wait in IDM. Check IDM > Downloads > Options.',
    );
  }

  return { max, stallMs, startTimeoutMs, dir, idmExe };
}

/** Seed a scheduler with the given rows and run it to completion. */
async function driveDownloads(rows, { max, stallMs, startTimeoutMs, dir, idmExe }, log, values) {
  const browser = await openBrowser({ headless: values.headless });
  const scheduler = new Scheduler({
    idmExe,
    browser,
    log,
    dir,
    max,
    stallMs,
    startTimeoutMs,
    onUpdate: printProgress,
  });

  const todo = scheduler.seed(rows);
  console.log(`${todo} to download, ${max} at a time.\n`);

  const stop = () => {
    console.log('\nStopping after the current tick. Progress is saved.');
    scheduler.stop();
  };
  process.on('SIGINT', stop);

  try {
    await scheduler.run();
  } finally {
    process.off('SIGINT', stop);
    await browser.close().catch(() => {});
  }
}

async function cmdRun(pasteUrl, values) {
  requireArg(pasteUrl, 'run <paste-url>');
  const setup = await prepareDownload(values);

  console.log('\nReading paste...');
  const { links } = await loadPaste(pasteUrl, values.password);
  const withIds = links.map((l) => ({ ...l, id: linkId(l.url) }));
  console.log(`Found ${withIds.length} links.`);

  const log = new RunLog(runLogPath(STATE_DIR, pasteUrl)).load();
  const resumed = log.resetInFlight();
  if (log.entries.size) {
    const c = log.counts();
    console.log(
      `Resuming: ${c[STATUS.DONE] ?? 0} already done, ${resumed} retried.`,
    );
  }

  await driveDownloads(withIds, setup, log, values);

  console.log('\n' + toMarkdown(buildRows(log.file)));
  console.log(`\nRun log: ${log.file}`);
}

/**
 * Redo only the files a past run marked failed.
 *
 * Everything needed is already in the run log, so the paste is never fetched
 * and the files that succeeded are never touched.
 */
async function cmdRetry(file, values) {
  const logFile = file ?? newestRunLog();
  if (!logFile) throw new Error('no run log found — pass one: retry <run-file>');

  const log = new RunLog(logFile).load();
  const failed = [...log.entries.values()].filter(
    (r) => r.status === STATUS.FAILED,
  );
  console.log(`Run log  : ${logFile}`);
  if (!failed.length) {
    console.log('Nothing failed in that run. Nothing to do.');
    return;
  }

  const dir = path.resolve(values.dir ?? 'downloads');
  console.log(`Checking : ${dir}`);
  console.log(`Failed   : ${failed.length}\n`);

  // Some "failures" were only ever a timeout — the file may already be there.
  const missing = [];
  let recovered = 0;
  for (const row of failed) {
    if (isCompleteOnDisk(dir, row.filename, row.size)) {
      log.record(row.id, { status: STATUS.DONE, bytes: row.size });
      recovered++;
    } else {
      missing.push(row);
    }
  }

  console.log(`Already complete on disk : ${recovered}`);
  console.log(`Still need downloading   : ${missing.length}`);

  if (recovered === 0 && failed.length > 0) {
    console.warn(
      `\nwarning: none of the ${failed.length} files were found in that folder.\n` +
        '         If the run saved somewhere else, pass the right --dir.',
    );
  }

  if (values['check-only']) {
    console.log('\n--check-only was set, so nothing was downloaded.');
    return;
  }
  if (!missing.length) {
    console.log('\nEverything is already on disk. Nothing to download.');
    console.log('\n' + toMarkdown(buildRows(log.file)));
    return;
  }

  const setup = await prepareDownload(values);
  log.resetFailed();
  await driveDownloads(missing, setup, log, values);

  console.log('\n' + toMarkdown(buildRows(log.file)));
  console.log(`\nRun log: ${log.file}`);
}

async function cmdReport(file, values) {
  const target = file ?? newestRunLog();
  if (!target) throw new Error('no run log found in ./state');
  const rows = buildRows(target);
  console.log(values.csv ? toCsv(rows) : toMarkdown(rows));
}

function newestRunLog() {
  if (!fs.existsSync(STATE_DIR)) return null;
  const files = fs
    .readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(STATE_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

let lastLines = 0;
function printProgress({ active, resolving, pending, counts }) {
  // Redraw in place so the console stays readable over a long run.
  if (lastLines) process.stdout.write(`\x1b[${lastLines}A\x1b[0J`);

  const lines = active.map((a) => {
    const pct = a.size ? ((a.bytes / a.size) * 100).toFixed(1) + '%' : '--';
    return `  ▸ ${truncate(a.filename, 46).padEnd(46)} ${pct.padStart(6)}  ${formatBytes(a.bytes)}`;
  });
  if (resolving) lines.push(`  ⋯ opening ${resolving} link(s) in the browser`);
  lines.push(
    `  done ${counts[STATUS.DONE] ?? 0} | failed ${counts[STATUS.FAILED] ?? 0} | active ${active.length} | waiting ${pending}`,
  );

  process.stdout.write(lines.join('\n') + '\n');
  lastLines = lines.length;
}

function truncate(text, n) {
  return text.length <= n ? text : text.slice(0, n - 1) + '…';
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function requireArg(value, shape) {
  if (!value) throw new Error(`missing argument — usage: ${shape}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof PasteError || err instanceof IdmError) {
    console.error(`\n${err.message}`);
  } else {
    console.error(`\nerror: ${err.message}`);
  }
  process.exitCode = 1;
}
