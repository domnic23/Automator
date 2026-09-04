// Rolling download scheduler.
//
// Exactly N downloads are kept in flight. The moment one finishes its slot is
// refilled, so two finishing together start two new ones. The batch is never
// waited on as a whole.

import { STATUS } from './state.js';
import { resolveLink, ResolveError } from './resolve.js';
import { enqueue, startQueue, checkProgress } from './idm.js';

const TICK_MS = 2000;

export class Scheduler {
  constructor({
    idmExe,
    browser,
    log,
    dir,
    max,
    stallMs = 30 * 60 * 1000,
    startTimeoutMs = 15 * 60 * 1000,
    onUpdate = () => {},
  }) {
    this.idmExe = idmExe;
    this.browser = browser;
    this.log = log;
    this.dir = dir;
    this.max = max;
    this.stallMs = stallMs;
    this.startTimeoutMs = startTimeoutMs;
    this.onUpdate = onUpdate;

    this.pending = [];
    this.active = new Map();
    this.filling = 0;
    this.stopped = false;
  }

  /** Queue up every link that is not already finished. */
  seed(links) {
    for (const link of links) {
      const prior = this.log.get(link.id);
      if (prior?.status === STATUS.DONE || prior?.status === STATUS.FAILED) {
        continue;
      }
      if (!prior) {
        this.log.record(link.id, {
          url: link.url,
          filename: link.filename,
          status: STATUS.PENDING,
        });
      }
      this.pending.push({ ...link, dir: this.dir });
    }
    return this.pending.length;
  }

  async run() {
    while (!this.stopped && (this.pending.length || this.active.size || this.filling)) {
      this.fillSlots();
      await this.tick();
      this.onUpdate(this.snapshot());
      await sleep(TICK_MS);
    }
    // One last poll so a download that ended on the final tick is recorded.
    await this.tick();
    this.onUpdate(this.snapshot());
  }

  stop() {
    this.stopped = true;
  }

  /** Start as many new downloads as there are free slots, without blocking. */
  fillSlots() {
    while (
      !this.stopped &&
      this.active.size + this.filling < this.max &&
      this.pending.length
    ) {
      const item = this.pending.shift();
      this.filling++;
      this.startOne(item)
        .catch((err) => this.fail(item, err.message))
        .finally(() => {
          this.filling--;
        });
    }
  }

  /**
   * Resolve one link and hand it to IDM.
   *
   * Resolution happens here, not upfront, because the direct URLs expire.
   */
  async startOne(item) {
    let resolved;
    try {
      resolved = await resolveLink(this.browser, item.url);
    } catch (err) {
      const reason =
        err instanceof ResolveError ? err.message : `unexpected: ${err.message}`;
      this.fail(item, reason);
      return;
    }

    item.size = resolved.size;
    item.lastBytes = -1;
    item.lastChangeAt = Date.now();
    item.queuedAt = Date.now();
    item.startedAt = new Date().toISOString();

    this.log.record(item.id, {
      status: STATUS.RESOLVED,
      size: resolved.size,
      startedAt: item.startedAt,
    });

    await enqueue(this.idmExe, {
      url: resolved.url,
      filename: item.filename,
      dir: this.dir,
      referer: resolved.referer,
      userAgent: resolved.userAgent,
    });
    await startQueue(this.idmExe);

    this.active.set(item.id, item);
    this.log.record(item.id, { status: STATUS.QUEUED });
  }

  /** Poll every active download and free the slots that are finished. */
  async tick() {
    for (const [id, item] of [...this.active]) {
      const { state, bytes } = checkProgress(item, { stallMs: this.stallMs });

      // IDM accepted the job but never put a byte on disk. Without this the
      // slot would be held for the whole run.
      if (state === 'missing') {
        if (Date.now() - item.queuedAt > this.startTimeoutMs) {
          this.active.delete(id);
          this.log.record(id, {
            status: STATUS.FAILED,
            startedAt: item.startedAt,
            error: `IDM never started this download within ${Math.round(this.startTimeoutMs / 60000)} min`,
          });
        }
        continue;
      }

      if (bytes !== item.lastBytes) {
        item.lastBytes = bytes;
        item.lastChangeAt = Date.now();
        if (state === 'running' && item.status !== STATUS.ACTIVE) {
          item.status = STATUS.ACTIVE;
          this.log.record(id, { status: STATUS.ACTIVE });
        }
      }

      if (state === 'done') {
        this.active.delete(id);
        this.log.record(id, { status: STATUS.DONE, bytes, startedAt: item.startedAt });
      } else if (state === 'stalled') {
        this.active.delete(id);
        this.log.record(id, {
          status: STATUS.FAILED,
          bytes,
          startedAt: item.startedAt,
          error: `no progress for ${Math.round(this.stallMs / 60000)} min`,
        });
      }
    }
  }

  fail(item, error) {
    this.active.delete(item.id);
    this.log.record(item.id, {
      status: STATUS.FAILED,
      error,
      startedAt: item.startedAt,
    });
  }

  snapshot() {
    return {
      active: [...this.active.values()].map((i) => ({
        filename: i.filename,
        bytes: i.lastBytes > 0 ? i.lastBytes : 0,
        size: i.size,
      })),
      resolving: this.filling,
      pending: this.pending.length,
      counts: this.log.counts(),
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
