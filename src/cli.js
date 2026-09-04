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
import { findIdm, idmSettingsPresent, IdmError } from './idm.js';
import { Scheduler } from './queue.js';
import { buildRows, toMarkdown, toCsv } from './report.js';

const STATE_DIR = path.resolve('state');

const USAGE = `
Automator — paste links to IDM

  links   <paste-url>                 decrypt the paste and list the links
  resolve <page-url>                  resolve one link to its direct file URL
  run     <paste-url>                 download everything through IDM
  report  [run-file]                  print a table of a finished run

Options for "run":
  --max <n>        how many downloads may be active at once   (default 3)
  --dir <path>     where to save files                        (default .\\downloads)
  --idm <path>     full path to IDMan.exe                     (auto-detected)
  --password <s>   paste password, if the paste has one
  --headless       hide the browser window (only after a headed first run)
  --stall <min>    give up on a download after this many idle minutes (default 30)
  --csv            for "report": print CSV instead of a table
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

async function cmdRun(pasteUrl, values) {
  requireArg(pasteUrl, 'run <paste-url>');

  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1 || max > 32) {
    throw new Error('--max must be a whole number between 1 and 32');
  }
  const stallMs = Number(values.stall) * 60000;
  if (!Number.isFinite(stallMs) || stallMs <= 0) {
    throw new Error('--stall must be a positive number of minutes');
  }

  const dir = path.resolve(values.dir ?? 'downloads');
  fs.mkdirSync(dir, { recursive: true });

  const idmExe = findIdm(values.idm);
  console.log(`IDM      : ${idmExe}`);
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

  const browser = await openBrowser({ headless: values.headless });
  const scheduler = new Scheduler({
    idmExe,
    browser,
    log,
    dir,
    max,
    stallMs,
    onUpdate: printProgress,
  });

  const todo = scheduler.seed(withIds);
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
