/**
 * Stop a running explorer from a terminal.
 *
 * The window the launcher opened is the usual way — Ctrl-C there — but it can be gone,
 * or on another desktop, or have been started from a double-click somebody has since
 * closed the browser on. This is the way back in either way.
 */

const PORT = Number(process.env.XLE_SERVICE_PORT ?? 8085);

try {
  const response = await fetch(`http://127.0.0.1:${PORT}/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(`Stopped the explorer on port ${PORT}.`);
} catch {
  console.log(`Nothing to stop on port ${PORT}.`);
}
