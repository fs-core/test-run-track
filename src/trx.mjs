import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: false,
  // Force arrays for the repeating nodes so single-test runs don't collapse
  // into a bare object and break every downstream .map().
  isArray: (name) => ['UnitTest', 'UnitTestResult'].includes(name),
});

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** "00:00:12.3456789" -> 12345.7 (ms) */
export function durationToMs(text) {
  if (!text) return null;
  const m = /^(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const fracMs = frac ? Number(`0.${frac}`) * 1000 : 0;
  return (Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + fracMs;
}

/**
 * Collapses a raw error message into a stable signature. Strips the parts that
 * vary between runs — guids, numbers, quoted literals, paths, urls — so the
 * same underlying failure gets the same fingerprint across tests and runs.
 */
export function normalizeError(message) {
  if (!message || !message.trim()) return null;
  let n = message
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '<guid>')
    .replace(/[A-Za-z]:\\[^\s:"']+/g, '<path>')
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    // No \b here: '30000ms' has no word boundary between the digit and the
    // unit suffix, so \b\d+\b silently skips every timeout value.
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length > 400) n = n.slice(0, 400);
  return n || null;
}

export function fingerprint(message) {
  const n = normalizeError(message);
  if (!n) return null;
  return createHash('sha1').update(n).digest('hex').slice(0, 12);
}

/** MSTest nests data-driven cases under <InnerResults>. Flatten them. */
function flattenResults(nodes, out = []) {
  for (const node of arr(nodes)) {
    const inner = node?.InnerResults?.UnitTestResult;
    if (inner) {
      flattenResults(inner, out);
    } else {
      out.push(node);
    }
  }
  return out;
}

function text(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return null;
}

/**
 * Parses a .trx into flat result records.
 * Returns { results, counts }.
 */
export function parseTrx(trxPath) {
  const doc = parser.parse(readFileSync(trxPath, 'utf8'));
  const run = doc?.TestRun;
  if (!run) throw new Error(`Not a TRX file (no TestRun element): ${trxPath}`);

  // testId -> canonical identity
  const defs = new Map();
  for (const ut of arr(run.TestDefinitions?.UnitTest)) {
    const tm = ut.TestMethod;
    if (!tm) continue;
    const className = tm['@className'] ?? '';
    const rawName = tm['@name'] ?? '';
    // Strip data-driven arguments: MyTest("a",1) -> MyTest. Without this the
    // FullyQualifiedName~ filter we generate would never match anything.
    const method = rawName.split('(')[0];
    const shortClass = className.split('.').pop() ?? className;
    defs.set(ut['@id'], {
      className,
      method,
      fullName: className ? `${className}.${method}` : method,
      shortName: `${shortClass}.${method}`,
    });
  }

  const results = [];
  for (const r of flattenResults(run.Results?.UnitTestResult)) {
    const def = defs.get(r['@testId']);
    const displayName = r['@testName'] ?? def?.fullName ?? '(unknown)';
    const info = r.Output?.ErrorInfo;
    const message = text(info?.Message);
    const stack = text(info?.StackTrace);

    results.push({
      fullName: def?.fullName ?? displayName,
      shortName: def?.shortName ?? displayName,
      className: def?.className ?? null,
      method: def?.method ?? null,
      displayName,
      outcome: r['@outcome'] ?? 'Unknown',
      durationMs: durationToMs(r['@duration']),
      message: message?.trim() || null,
      stack: stack?.trim() || null,
      stdout: text(r.Output?.StdOut)?.trim() || null,
    });
  }

  const counts = {
    total: results.length,
    passed: results.filter((r) => r.outcome === 'Passed').length,
    failed: results.filter((r) => r.outcome === 'Failed').length,
    skipped: results.filter((r) => !['Passed', 'Failed'].includes(r.outcome)).length,
  };

  return { results, counts };
}

/**
 * Builds the dotnet --filter string for rerunning just the failures.
 * Dedupes so N failing data rows of one test produce one filter term.
 */
export function buildRerunFilter(failures, { short = false } = {}) {
  const names = [...new Set(failures.map((f) => (short ? f.shortName : f.fullName)))].sort();
  if (!names.length) return null;
  return names.map((n) => `FullyQualifiedName~${n}`).join('|');
}
