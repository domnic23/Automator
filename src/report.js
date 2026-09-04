// Turn a run log into a table.

import { RunLog, STATUS } from './state.js';

function duration(row) {
  if (!row.startedAt || !row.at) return '';
  const ms = new Date(row.at) - new Date(row.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

export function buildRows(file) {
  const log = new RunLog(file).load();
  return [...log.entries.values()].sort((a, b) =>
    (a.filename ?? '').localeCompare(b.filename ?? ''),
  );
}

export function toMarkdown(rows) {
  const head =
    '| # | File | Status | Took | Note |\n|---:|---|---|---|---|';
  const body = rows
    .map((r, i) =>
      `| ${i + 1} | ${r.filename ?? '?'} | ${r.status ?? '?'} | ${duration(r)} | ${
        (r.error ?? '').replace(/\|/g, '/')
      } |`,
    )
    .join('\n');

  const done = rows.filter((r) => r.status === STATUS.DONE).length;
  const failed = rows.filter((r) => r.status === STATUS.FAILED).length;
  const other = rows.length - done - failed;

  return `${head}\n${body}\n\n**${done} done, ${failed} failed, ${other} unfinished, ${rows.length} total.**`;
}

export function toCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['filename,status,took,url,error'];
  for (const r of rows) {
    lines.push(
      [r.filename, r.status, duration(r), r.url, r.error].map(esc).join(','),
    );
  }
  return lines.join('\n');
}
