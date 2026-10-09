// The tab's end of the shared rate limit.
//
// It used to guess: measure how long the server took and stay slower than that.
// The guess is no longer needed, because the limit was measured. From a cold
// bucket exactly 30 requests to /api/v2/users succeed and the 31st gets a 429;
// paced at one per second, 45 in a row draw nothing. That is a token bucket of
// 30 refilling at about 1 per second, and it is shared across domains per IP.
//
// So the bucket lives in the service worker, set a margin below those numbers
// (see worker.js), and this is the queue in front of it. The queue is what makes cancelling possible: a card scrolled off screen
// is dropped before it ever asks for a token.

(() => {
  const CONCURRENCY = 3; // only decides how fast a full bucket drains
  const REFILL_MS = 1250; // one token at the worker's 0.8 per second

  async function ask(k, payload) {
    try {
      const out = await chrome.runtime.sendMessage({ k, ...payload });
      return out && !out.error ? out : null;
    } catch (e) {
      return null;
    }
  }

  class SharedThrottle {
    constructor() {
      this.queue = [];
      this.active = 0;
      this.waiting = new Set(); // jobs holding a token, sleeping out its delay
      this.blockedUntil = 0;
      this.tokens = 20;
      this.stats = { sent: 0, failed: 0, throttled: 0 };
    }

    get circuitOpen() {
      return Date.now() < this.blockedUntil;
    }

    get pending() {
      return this.queue.length + this.active;
    }

    // Roughly how long the queue in front of us takes to clear, at the refill
    // rate. The popup shows this so a euro domain can say how far along it is
    // instead of looking broken.
    get etaMs() {
      const owed = Math.max(0, this.pending - Math.floor(this.tokens));
      return Math.max(this.blockedUntil - Date.now(), owed * REFILL_MS);
    }

    // task() must resolve to { ok, status, retryAfter }. It may also resolve to
    // { skipped: true } to hand the token straight back.
    submit(key, task) {
      return new Promise((resolve, reject) => {
        this.queue.push({ key, task, resolve, reject });
        this._drain();
      });
    }

    cancel(predicate) {
      const keep = [];
      for (const job of this.queue) {
        if (predicate(job.key)) job.reject(new Error('cancelled'));
        else keep.push(job);
      }
      const dropped = this.queue.length - keep.length;
      this.queue = keep;
      // A job past the queue may hold a token and still be sleeping out its
      // delay, which is seconds once the burst is spent. Waking it hands the
      // token back now and frees the slot for a card that is on screen.
      for (const job of this.waiting) {
        if (predicate(job.key)) {
          job.cancelled = true;
          job.wake();
        }
      }
      return dropped;
    }

    _drain() {
      while (this.active < CONCURRENCY && this.queue.length) {
        const job = this.queue.shift();
        this.active++;
        this._run(job).finally(() => {
          this.active--;
          this._drain();
        });
      }
    }

    async _run(job) {
      // The token is taken immediately before the request, so a job cancelled
      // while it waited in the queue never cost anything.
      const grant = await ask('reserve');
      if (!grant) {
        // No worker, so no budget to speak for. Run once rather than stall the
        // page: without the worker there is no cache either and the tab is
        // about to be reloaded anyway.
        return this._invoke(job);
      }
      if (!grant.ok) {
        this.blockedUntil = Date.now() + (grant.blockedMs || 0);
        this.stats.throttled++;
        const err = new Error('rate limited');
        job.reject(err);
        for (const queued of this.queue.splice(0)) queued.reject(err);
        return;
      }
      if (grant.waitMs > 0) {
        this.waiting.add(job);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, grant.waitMs);
          job.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.waiting.delete(job);
        if (job.cancelled) {
          ask('release');
          job.reject(new Error('cancelled'));
          return;
        }
      }
      return this._invoke(job);
    }

    async _invoke(job) {
      let result, error;
      try {
        result = await job.task();
      } catch (e) {
        error = e;
      }

      if (result && result.skipped) {
        ask('release');
        job.resolve(result);
        return;
      }

      if (!error && result && result.ok) {
        this.stats.sent++;
        this.tokens = Math.max(0, this.tokens - 1);
        ask('report', { ok: true });
        job.resolve(result);
        return;
      }

      const status = (result && result.status) || 0;
      const pushback = status === 429 || status === 403 || status === 503;
      ask('report', { ok: false, status, retryAfter: result && result.retryAfter });

      if (pushback) {
        this.stats.throttled++;
        // Vinted answers 429 with Retry-After: 60. Assume that until the next
        // reserve comes back with the worker's real number.
        this.blockedUntil = Date.now() + 60000;
      } else {
        this.stats.failed++;
      }
      job.reject(error || new Error('failed: ' + status));
    }

    // Pulls the shared numbers over for the popup.
    async refresh() {
      const state = await ask('bucket');
      if (!state) return;
      this.tokens = state.tokens;
      this.blockedUntil = Date.now() + (state.blockedMs || 0);
      this.stats.sent = state.sent;
      this.stats.throttled = state.throttled;
      this.stats.failed = state.failed;
    }
  }

  globalThis.VCF_Throttle = SharedThrottle;
})();
