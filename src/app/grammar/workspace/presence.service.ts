import { Injectable, OnDestroy } from '@angular/core';

/** How often to say we are still here. Short, so a reload's gap closes quickly. */
const EVERY_MS = 5000;

/**
 * Tell the launcher this window is open, so it can stop when the last one closes.
 *
 * Only meaningful when the launcher served this page: it reports to *this* origin, and
 * under `ng serve` that is the dev server, which answers 404 and is none the wiser. So
 * there is nothing to configure and nothing to switch off — the report lands where it
 * matters and nowhere else.
 *
 * `pagehide` rather than `beforeunload`: it fires for a tab going into the back/forward
 * cache and on mobile, where `beforeunload` does not, and it is the event browsers
 * still allow `sendBeacon` from. A beacon rather than a fetch because the page is on
 * its way out — a fetch at that point is cancelled as often as it is sent.
 *
 * The goodbye is a hint, not a contract. A window that dies without sending one — a
 * crash, a pulled network — is noticed anyway when it stops saying hello.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService implements OnDestroy {
  private readonly id = newId();
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    if (typeof window === 'undefined') return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), EVERY_MS);
    window.addEventListener('pagehide', this.leave);
    // A tab coming back to the front has had its timer throttled to about once a
    // minute; check in immediately rather than waiting out the rest of that minute.
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private async ping(): Promise<void> {
    try {
      await fetch('/alive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.id }),
        keepalive: true,
      });
    } catch {
      // Nothing is listening — this page was not served by the launcher.
    }
  }

  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible') void this.ping();
  };

  private readonly leave = (): void => {
    const body = new Blob([JSON.stringify({ id: this.id })], { type: 'application/json' });
    navigator.sendBeacon?.('/bye', body);
  };

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.leave);
    document.removeEventListener('visibilitychange', this.onVisible);
  }
}

/** `randomUUID` needs a secure context; 127.0.0.1 counts, but a fallback costs little. */
function newId(): string {
  const random = globalThis.crypto as Crypto | undefined;
  if (random?.randomUUID) return random.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
