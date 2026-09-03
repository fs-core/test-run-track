import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

import {
  parseTrx, buildRerunFilter, fingerprint, normalizeError, durationToMs,
} from '../src/trx.mjs';
import { parseListTests, chunkTests, chunkByClass, buildWorkerFilter, mergeWorkerResults } from '../src/parallel.mjs';
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

/* --------------------------------------------------------------- parallel - */

describe('parseListTests', () => {
  test('extracts test names after the marker', () => {
    const out = [
      'Build started, please wait...',
      'The following Tests are available:',
      '    Ns.Cls.MethodA',
      '    Ns.Cls.MethodB',
      '',
    ].join('\n');
    assert.deepEqual(parseListTests(out), ['Ns.Cls.MethodA', 'Ns.Cls.MethodB']);
  });

  test('returns empty when marker is absent', () => {
    assert.deepEqual(parseListTests('Build failed.\nNo output.'), []);
  });

  test('handles CRLF line endings', () => {
    const out = 'The following Tests are available:\r\n    A.B.C\r\n';
    assert.deepEqual(parseListTests(out), ['A.B.C']);
  });

  test('returns empty on null/undefined input', () => {
    assert.deepEqual(parseListTests(null), []);
    assert.deepEqual(parseListTests(undefined), []);
  });
});

describe('chunkTests', () => {
  test('splits 13 tests into 3 even-ish chunks', () => {
    const tests = Array.from({ length: 13 }, (_, i) => `T${i}`);
    const chunks = chunkTests(tests, 3);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 5);
    assert.equal(chunks[1].length, 5);
    assert.equal(chunks[2].length, 3);
    assert.equal(chunks.flat().length, 13);
  });

  test('returns one chunk when n=1', () => {
    const tests = ['A', 'B', 'C'];
    assert.deepEqual(chunkTests(tests, 1), [['A', 'B', 'C']]);
  });

  test('caps at test count when n exceeds number of tests', () => {
    const chunks = chunkTests(['A', 'B'], 5);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.flat(), ['A', 'B']);
  });

  test('returns one chunk for an empty list', () => {
    assert.deepEqual(chunkTests([], 4), [[]]);
  });
});

describe('chunkByClass', () => {
  test('keeps all tests from the same class in the same worker', () => {
    const names = [
      'Ns.ClsA.Test1', 'Ns.ClsA.Test2',
      'Ns.ClsB.Test1', 'Ns.ClsB.Test2',
      'Ns.ClsC.Test1',
    ];
    const chunks = chunkByClass(names, 4);
    for (const chunk of chunks) {
      const classes = new Set(chunk.map((n) => n.slice(0, n.lastIndexOf('.'))));
      assert.equal(classes.size, 1, 'each worker must contain only one class');
    }
  });

  test('caps worker count at number of classes', () => {
    const names = ['A.T1', 'A.T2', 'B.T1'];
    const chunks = chunkByClass(names, 10);
    assert.equal(chunks.length, 2);
  });

  test('all tests present across workers', () => {
    const names = ['A.T1', 'A.T2', 'B.T1', 'C.T1', 'C.T2', 'C.T3'];
    const chunks = chunkByClass(names, 3);
    assert.deepEqual(chunks.flat().sort(), names.sort());
  });

  test('returns one worker when n=1', () => {
    const names = ['A.T1', 'B.T1'];
    const chunks = chunkByClass(names, 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2);
  });
});

describe('buildWorkerFilter', () => {
  test('joins names with pipe and FullyQualifiedName~ prefix', () => {
    assert.equal(
      buildWorkerFilter(['Ns.Cls.A', 'Ns.Cls.B']),
      'FullyQualifiedName~Ns.Cls.A|FullyQualifiedName~Ns.Cls.B',
    );
  });

  test('single name has no pipe', () => {
    assert.equal(buildWorkerFilter(['Ns.Cls.A']), 'FullyQualifiedName~Ns.Cls.A');
  });
});

describe('mergeWorkerResults', () => {
  test('aggregates results and counts from multiple payloads', () => {
    const p1 = { results: [{ outcome: 'Passed' }], counts: { total: 1, passed: 1, failed: 0, skipped: 0 } };
    const p2 = { results: [{ outcome: 'Failed' }, { outcome: 'Passed' }], counts: { total: 2, passed: 1, failed: 1, skipped: 0 } };
    const { results, counts } = mergeWorkerResults([p1, p2]);
    assert.equal(results.length, 3);
    assert.deepEqual(counts, { total: 3, passed: 2, failed: 1, skipped: 0 });
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
  after(() => { try { database.close(); } catch {} });

  test('openDb is idempotent', () => {
    const again = db.openDb(join(dir, 'db', 'e2e.db'));
    assert.ok(again.prepare('SELECT count(*) c FROM runs').get().c > 0);
    again.close();
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

  test('workers column is stored and queried; null for sequential runs', () => {
    // Insert a parallel run
    const { results, counts } = parseTrx(writeTrx('par', SCENARIO[0]));
    db.insertRun(database, {
      runKey: '20260910-120000', card: 'PANK1835', env: 'qa',
      filter: 'FullyQualifiedName~PANK1835',
      startedAt: new Date(Date.UTC(2026, 8, 10, 12)).toISOString(),
      elapsedSec: 60, counts, trxPath: '/tmp/par',
      gitSha: null, gitBranch: null,
      workers: 4,
    }, results, fingerprint, normalizeError);

    const parallel = db.runByKey(database, '20260910-120000');
    assert.equal(parallel.workers, 4);

    // Sequential runs written in before() have no workers field → null
    const sequential = db.runByKey(database, '20260901-120000');
    assert.equal(sequential.workers, null);
  });

  test('openDb migrates an existing DB without the workers column', () => {
    // Build a v1-style DB: create it, drop the workers column via recreation.
    const migrateDbPath = join(dir, 'migrate', 'e2e.db');
    mkdirSync(dirname(migrateDbPath), { recursive: true });
    const raw = new DatabaseSync(migrateDbPath);
    raw.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY, run_key TEXT NOT NULL UNIQUE,
      card TEXT NOT NULL, env TEXT NOT NULL, filter TEXT,
      started_at TEXT NOT NULL DEFAULT '', elapsed_sec REAL,
      total INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
      git_sha TEXT, git_branch TEXT, trx_path TEXT
    )`);
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    raw.prepare(`INSERT INTO meta VALUES ('schema_version', '1')`).run();
    raw.close();

    // openDb should add workers without throwing
    const migrated = db.openDb(migrateDbPath);
    const cols = migrated.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    migrated.close();
    assert.ok(cols.includes('workers'), 'workers column should exist after migration');
  });
});
