/**
 * Poll `pred` every 5ms until it returns true, instead of a single fixed-delay
 * `await new Promise(r => setTimeout(r, N))`. Under parallel vitest workers a
 * fixed delay is not reliably long enough for an async write chain to settle,
 * which makes assertions that immediately follow it flaky. Polling for the
 * actual condition the next assertion needs removes that race without
 * weakening what's asserted.
 */
export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`until(): condition not met within ${ms}ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}
