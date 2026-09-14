/**
 * Who still has the explorer open.
 *
 * The launcher starts a server and a browser, and only the browser is the reason the
 * server exists — so when the last window goes, the server should follow. Watching the
 * spawned process cannot tell us that: `open -a` returns in under a tenth of a second,
 * long before anyone has looked at the page, and if the browser was already running it
 * never owned the tab at all.
 *
 * So the page reports instead, and this decides what the reports mean. Each page
 * instance has an id: it says hello repeatedly while it lives and goodbye when it goes.
 *
 * Two things make that less trivial than counting.
 *
 *  - **A reload looks exactly like a close**, because it is one — `pagehide` fires and
 *    a new instance appears a moment later under a new id. So an empty set does not
 *    mean "gone", only "gone for now", and the decision waits a few seconds for
 *    somebody to come back.
 *  - **A background tab's timers are throttled** to about once a minute, so a page
 *    that is merely not in front must not be mistaken for one that has closed. Its
 *    hellos are allowed to be a long time apart; it is the explicit goodbye that ends
 *    things promptly.
 */

export class Presence {
  #clients = new Map();
  #served = false;
  #emptySince;

  /**
   * @param staleMs how long a silent client is still considered present — longer than
   *   the minute a throttled background tab can take to check in.
   * @param emptyMs how long to wait with nobody there before saying so, which is the
   *   gap a reload has to get back through.
   */
  constructor({ staleMs = 90_000, emptyMs = 8_000, now = Date.now } = {}) {
    this.staleMs = staleMs;
    this.emptyMs = emptyMs;
    this.now = now;
  }

  /** A page says it is still there. */
  seen(id) {
    this.#clients.set(id, this.now());
    this.#served = true;
    this.#emptySince = undefined;
  }

  /** A page says it is going. */
  gone(id) {
    this.#clients.delete(id);
    // Time the wait from the goodbye, not from whenever the watchdog next looks:
    // the reload it exists for starts now, and so should the grace it gets.
    if (this.#served && this.#clients.size === 0) this.#emptySince = this.now();
  }

  get size() {
    return this.#clients.size;
  }

  /** True once any page has ever checked in; before that there is nothing to outlive. */
  get served() {
    return this.#served;
  }

  /**
   * Whether the last window has gone: `'exit'` or `'wait'`.
   *
   * Never `'exit'` before a first client, or the server would stop while the browser
   * was still starting.
   */
  check() {
    const now = this.now();
    for (const [id, at] of this.#clients) {
      if (now - at > this.staleMs) this.#clients.delete(id);
    }
    if (!this.#served) return 'wait';
    if (this.#clients.size > 0) {
      this.#emptySince = undefined;
      return 'wait';
    }
    if (this.#emptySince === undefined) this.#emptySince = now;
    return now - this.#emptySince >= this.emptyMs ? 'exit' : 'wait';
  }
}
