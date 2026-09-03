/**
 * Utilities for the parallel workers path in `e2e run --workers N`.
 * Kept separate so they can be unit-tested without a dotnet SDK.
 */

/**
 * Parses the stdout of `dotnet test --list-tests` and returns the test names.
 * The output looks like:
 *   ...build noise...
 *   The following Tests are available:
 *       Ns.Cls.Method1
 *       Ns.Cls.Method2
 */
export function parseListTests(stdout) {
  const lines = (stdout ?? '').split(/\r?\n/);
  const marker = lines.findIndex((l) => l.includes('The following Tests are available:'));
  if (marker === -1) return [];
  return lines
    .slice(marker + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Splits an array of test names into N roughly-equal chunks.
 * Produces at most `names.length` chunks (capped naturally when N > count).
 */
export function chunkTests(names, n) {
  if (n <= 1 || names.length === 0) return [names];
  const size = Math.ceil(names.length / n);
  const chunks = [];
  for (let i = 0; i < names.length; i += size) chunks.push(names.slice(i, i + size));
  return chunks;
}

/**
 * Builds a `FullyQualifiedName~` OR filter for one worker's chunk of tests.
 */
export function buildWorkerFilter(names) {
  return names.map((n) => `FullyQualifiedName~${n}`).join('|');
}

/**
 * Merges per-worker { results, counts } payloads into one.
 */
export function mergeWorkerResults(workerPayloads) {
  const results = [];
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const { results: r, counts: c } of workerPayloads) {
    results.push(...r);
    counts.total += c.total;
    counts.passed += c.passed;
    counts.failed += c.failed;
    counts.skipped += c.skipped;
  }
  return { results, counts };
}
