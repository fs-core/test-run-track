import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseTrx, buildRerunFilter, fingerprint, normalizeError, durationToMs,
} from '../src/trx.mjs';
import * as db from '../src/db.mjs';
import { classify } from '../src/render.mjs';
import {
  makeTrx, makeSingleTestTrx, makeInnerResultsTrx, SCENARIO, CLASS_NAME,
} from './fixtures.mjs';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'e2e-test-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const writeTrx = (name, xml) => {
  const p = join(dir, `${name}.trx`);
  writeFileSync(p, xml);
  return p;
};

/* ------------------------------------------------------------------ trx --- */

describe('durationToMs', () => {
  test('parses TRX duration format', () => {
    assert.equal(Math.round(durationToMs('00:00:02.4821000')), 2482);
    assert.equal(durationToMs('00:01:30'), 90000);
    assert.equal(durationToMs('01:00:00'), 3600000);
  });
  test('returns null for junk', () => {
    assert.equal(durationToMs(null), null);
    assert.equal(durationToMs('nonsense'), null);
  });
});

describe('parseTrx', () => {
  test('counts outcomes', () => {
    const p = writeTrx('counts', makeTrx([
      { name: 'A', outcome: 'Passed' },
      { name: 'B', outcome: 'Failed' },
      { name: 'C', outcome: 'NotExecuted' },
    ]));
    const { counts } = parseTrx(p);
    assert.deepEqual(counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
  });

  test('does not collapse a single-test run into a bare object', () => {
    // fast-xml-parser returns an object, not an array, for a lone element
    // unless isArray is configured. Regression guard for that config.
    const { results, counts } = parseTrx(writeTrx('single', makeSingleTestTrx()));
    assert.equal(counts.total, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'Failed');
  });

  test('strips data-driven arguments from fullName but keeps them in displayName', () => {
    // Load-bearing: fullName feeds the rerun filter. If args leak in, the
    // generated FullyQualifiedName~ filter matches nothing and a rerun
    // silently "passes".
    const { results } = parseTrx(writeTrx('args', makeTrx([
      { name: 'BulkTagApplies', outcome: 'Failed', args: '"bulk",25' },
    ])));
    assert.equal(results[0].fullName, `${CLASS_NAME}.BulkTagApplies`);
    assert.equal(results[0].shortName, 'Pank1835DonorGridTests.BulkTagApplies');
    assert.match(results[0].displayName, /BulkTagApplies\("bulk",25\)/);
  });

  test('flattens MSTest InnerResults', () => {
    const { results, counts } = parseTrx(writeTrx('inner', makeInnerResultsTrx()));
    assert.equal(counts.total, 3, 'parent should be replaced by its 3 child cases');
    assert.equal(counts.failed, 1);
    assert.ok(results.every((r) => r.fullName === `${CLASS_NAME}.BulkTagApplies`));
  });

  test('captures message and stack on failures', () => {
    const { results } = parseTrx(writeTrx('err', makeTrx([{ name: 'A', outcome: 'Failed' }])));
    assert.match(results[0].message, /Timeout 30000ms/);
    assert.match(results[0].stack, /WaitForSelectorAsync/);
    assert.ok(results[0].message.includes('<detached>'), 'entities should be decoded');
  });

  test('throws a clear error on a non-TRX file', () => {
    const p = writeTrx('bad', '<html><body>not a trx</body></html>');
    assert.throws(() => parseTrx(p), /no TestRun element/);
  });
});

/* ---------------------------------------------------------- fingerprints --- */

describe('normalizeError / fingerprint', () => {
  test('strips guids, numbers, paths, urls and quoted strings', () => {
    const n = normalizeError(
      'Timeout 30000ms waiting for "#row-4" at https://qa.local/x?p=2 ' +
      'session 8f14e45f-ceea-467a-9c1a-9b5a0e5c1d22 in C:\\code\\a\\b.cs',
    );
    assert.ok(!/30000/.test(n), 'numbers should be masked');
    assert.ok(!/8f14e45f/.test(n), 'guids should be masked');
    assert.ok(!/qa\.local/.test(n), 'urls should be masked');
    assert.ok(!/C:\\/.test(n), 'paths should be masked');
  });

  test('same failure shape yields the same fingerprint', () => {
    const a = fingerprint('Timeout 30000ms waiting for "#row-1" at https://qa/x?p=1');
    const b = fingerprint('Timeout 30000ms waiting for "#row-9" at https://qa/x?p=9');
    assert.equal(a, b);
  });

  test('different failure shapes differ', () => {
    const a = fingerprint('Timeout waiting for selector');
    const b = fingerprint('Expected 3 rows but found none');
    assert.notEqual(a, b);
  });

  test('null-safe', () => {
    assert.equal(fingerprint(null), null);
    assert.equal(fingerprint('   '), null);
  });
});

/* --------------------------------------------------------- rerun filter --- */

describe('buildRerunFilter', () => {
  const f = (n) => ({ fullName: `Ns.Cls.${n}`, shortName: `Cls.${n}` });

  test('joins terms with a pipe', () => {
    assert.equal(buildRerunFilter([f('A'), f('B')]),
      'FullyQualifiedName~Ns.Cls.A|FullyQualifiedName~Ns.Cls.B');
  });

  test('dedupes repeated data-driven cases of one test', () => {
    assert.equal(buildRerunFilter([f('A'), f('A'), f('A')]),
      'FullyQualifiedName~Ns.Cls.A');
  });

  test('honours --short', () => {
    assert.equal(buildRerunFilter([f('A')], { short: true }), 'FullyQualifiedName~Cls.A');
  });

  test('returns null with no failures', () => {
    assert.equal(buildRerunFilter([]), null);
  });
});

/* ---------------------------------------------------------------- verdicts - */

describe('classify', () => {
  test('flags repeated flips as FLAKY', () => {
    const c = classify('.X.X.X'.split(''));
    assert.equal(c.verdict, 'FLAKY');
    assert.equal(c.flips, 5);
  });

  test('flags a break-and-stay as a recent regression, not flake', () => {
    // Same 50% failure rate as the flaky case above - transitions are what
    // separates them.
    const c = classify('...XXX'.split(''));
    assert.equal(c.verdict, 'broke recently');
    assert.equal(c.failPct, 50);
  });

  test('all-pass is stable, all-fail is always failing', () => {
    assert.equal(classify('......'.split('')).verdict, 'stable');
    assert.equal(classify('XXXXXX'.split('')).verdict, 'always failing');
  });
});

/* --------------------------------------------------------------------- db - */

describe('database', () => {
  let database;
  const shas = ['a1b2c3d', 'b2c3d4e', 'c3d4e5f', 'd4e5f6a', 'e5f6a7b', 'f6a7b8c'];
  const FULL = (n) => `${CLASS_NAME}.${n}`;

  before(() => {
    const dbDir = join(dir, 'db');
    mkdirSync(dbDir, { recursive: true });
    database = db.openDb(join(dbDir, 'e2e.db'));
    SCENARIO.forEach((xml, i) => {
      const p = writeTrx(`scenario${i}`, xml);
      const { results, counts } = parseTrx(p);
      db.insertRun(database, {
        runKey: `2026090${i + 1}-12000${i}`, card: 'PANK1835', env: 'qa',
        filter: 'FullyQualifiedName~PANK1835',
        startedAt: new Date(Date.UTC(2026, 8, i + 1, 12)).toISOString(),
        elapsedSec: 180 + i, counts, trxPath: p,
        gitSha: shas[i], gitBranch: 'feature/PANK-1835',
      }, results, fingerprint, normalizeError);
    });
  });

  test('openDb is idempotent', () => {
    const again = db.openDb(join(dir, 'db', 'e2e.db'));
    assert.ok(again.prepare('SELECT count(*) c FROM runs').get().c > 0);
  });

  test('records every run', () => {
    assert.equal(db.recentRuns(database, 'PANK1835', 50).length, 6);
  });

  test('recentRuns returns oldest-first', () => {
    const runs = db.recentRuns(database, 'PANK1835', 50);
    assert.equal(runs[0].git_sha, 'a1b2c3d');
    assert.equal(runs.at(-1).git_sha, 'f6a7b8c');
  });

  test('v_run_test collapses data-driven cases to one row per test per run', () => {
    const rows = database.prepare(
      'SELECT count(*) c FROM v_run_test v JOIN runs r ON r.id=v.run_id WHERE r.run_key=?',
    ).get('20260904-120003');
    assert.equal(rows.c, 5, 'five tests, regardless of how many cases each ran');
  });

  test('testSequences produces oldest-first patterns', () => {
    const seqs = db.testSequences(database, 'PANK1835', 20);
    const byName = Object.fromEntries(seqs.map((s) => [s.fullName, s.seq.join('')]));
    assert.equal(byName[FULL('BulkTagApplies')], '.X.X.X');
    assert.equal(byName[FULL('DonorExportRespectsFilter')], '...XXX');
    assert.equal(byName[FULL('GridSortsByLastGift')], '......');
  });

  test('errorClusters groups failures sharing a signature', () => {
    const last = db.lastRun(database, 'PANK1835');
    const clusters = db.errorClusters(database, last.id);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].test_count, 2);
  });

  test('regressionWindow brackets the breaking commit', () => {
    const w = db.regressionWindow(database, FULL('DonorExportRespectsFilter'), 'PANK1835');
    assert.equal(w.lastPass.git_sha, 'c3d4e5f');
    assert.equal(w.firstFail.git_sha, 'd4e5f6a');
  });

  test('regressionWindow reports no failure for a stable test', () => {
    const w = db.regressionWindow(database, FULL('GridSortsByLastGift'), 'PANK1835');
    assert.ok(w.lastPass);
    assert.equal(w.firstFail, null);
  });

  test('failingNames feeds a usable rerun filter', () => {
    const last = db.lastRun(database, 'PANK1835');
    const filter = buildRerunFilter(db.failingNames(database, last.id)
      .map((f) => ({ fullName: f.full_name, shortName: f.short_name })));
    assert.ok(filter.includes('FullyQualifiedName~'));
    assert.ok(!filter.includes('('), 'data-driven args must not leak into the filter');
    assert.equal(filter.split('|').length, 2);
  });

  test('lastRun can exclude a run, for previous-run diffing', () => {
    const last = db.lastRun(database, 'PANK1835');
    const prev = db.lastRun(database, 'PANK1835', last.run_key);
    assert.notEqual(prev.run_key, last.run_key);
    assert.equal(prev.git_sha, 'e5f6a7b');
  });
});
