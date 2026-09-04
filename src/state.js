// Append-only JSONL run log. One line per status change.
// Replaying the file rebuilds the current state, so a crashed run can resume.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUS = {
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

/** Stable id for a link, so resume works across runs. */
export function linkId(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}

/** A run is keyed by the paste URL, so re-running the same paste resumes it. */
export function runLogPath(stateDir, pasteUrl) {
  const id = crypto.createHash('sha1').update(pasteUrl).digest('hex').slice(0, 12);
  return path.join(stateDir, `run-${id}.jsonl`);
}

export class RunLog {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Read the existing log and rebuild the latest state of every link. */
  load() {
    if (!fs.existsSync(this.file)) return this;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // tolerate a torn last line from a hard kill
      }
      if (!row.id) continue;
      this.entries.set(row.id, { ...this.entries.get(row.id), ...row });
    }
    return this;
  }

  get(id) {
    return this.entries.get(id);
  }

  /**
   * In-flight states are not trustworthy after a crash: we cannot know whether
   * IDM really took the job. Reset them to PENDING so they are retried.
   */
  resetInFlight() {
    let reset = 0;
    for (const [id, row] of this.entries) {
      if (
        row.status === STATUS.RESOLVED ||
        row.status === STATUS.QUEUED ||
        row.status === STATUS.ACTIVE
      ) {
        this.entries.set(id, { ...row, status: STATUS.PENDING });
        reset++;
      }
    }
    return reset;
  }

  /** Record a status change. Written through to disk immediately. */
  record(id, fields) {
    const row = {
      ...this.entries.get(id),
      ...fields,
      id,
      at: new Date().toISOString(),
    };
    this.entries.set(id, row);
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  }

  counts() {
    const out = { total: this.entries.size };
    for (const row of this.entries.values()) {
      out[row.status] = (out[row.status] ?? 0) + 1;
    }
    return out;
  }
}
