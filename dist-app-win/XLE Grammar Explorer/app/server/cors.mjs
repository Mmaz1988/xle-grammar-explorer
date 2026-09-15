/**
 * Which origins may read this service's replies.
 *
 * Pinning a single port was a real bug: `ng serve` takes whatever port is free, and on
 * 4300 every reply was blocked, so the sentence bar fell back to headword matching
 * without anything visibly failing. Any loopback origin is allowed instead — loopback
 * only, because the service runs XLE over paths the caller names.
 */

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export function originFor(requestOrigin, allowed = process.env.XLE_SERVICE_ORIGIN) {
  if (allowed) return allowed;
  if (typeof requestOrigin === 'string' && LOOPBACK.test(requestOrigin)) return requestOrigin;
  return 'null';
}
