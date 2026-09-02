import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per invocation of the runner.
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  run_key     TEXT    NOT NULL UNIQUE,
  card        TEXT    NOT NULL,
  env         TEXT    NOT NULL,
  filter      TEXT,
  started_at  TEXT    NOT NULL,
  elapsed_sec REAL,
  total       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  git_sha     TEXT,
  git_branch  TEXT,
  trx_path    TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_card ON runs(card, started_at);

-- Stable identity for a test, independent of any run. This is the thing
-- JSONL could not give us: one row per test, joinable.
CREATE TABLE IF NOT EXISTS tests (
  id         INTEGER PRIMARY KEY,
  full_name  TEXT NOT NULL UNIQUE,
  class_name TEXT,
  method     TEXT,
  short_name TEXT
);

-- Stable identity for a failure signature, shared across tests and runs.
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  normalized  TEXT,
  sample      TEXT,
  first_seen  TEXT
);

-- One row per test case per run. Data-driven tests produce several rows
-- sharing a test_id, which is why aggregation goes through v_run_test.
CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_id      INTEGER NOT NULL REFERENCES tests(id),
  error_id     INTEGER REFERENCES errors(id),
  display_name TEXT,
  outcome      TEXT NOT NULL,
  duration_ms  REAL,
  message      TEXT,
  stack        TEXT
);
CREATE INDEX IF NOT EXISTS ix_results_run   ON results(run_id);
CREATE INDEX IF NOT EXISTS ix_results_test  ON results(test_id);
CREATE INDEX IF NOT EXISTS ix_results_error ON results(error_id);

-- Collapses data-driven cases: a test counts as failed in a run if any of
-- its cases failed.
CREATE VIEW IF NOT EXISTS v_run_test AS
SELECT run_id,
       test_id,
       MAX(CASE WHEN outcome = 'Failed' THEN 1 ELSE 0 END) AS failed,
       COUNT(*)                                            AS cases,
       SUM(COALESCE(duration_ms, 0))                       AS duration_ms
FROM results
GROUP BY run_id, test_id;
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');   // lets CI jobs write concurrently
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/* ------------------------------------------------------------------ write - */

function upsertTest(db, r) {
  db.prepare(`
    INSERT INTO tests(full_name, class_name, method, short_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(full_name) DO UPDATE SET
      class_name = excluded.class_name,
      method     = excluded.method,
      short_name = excluded.short_name
  `).run(r.fullName, r.className, r.method, r.shortName);
  return db.prepare('SELECT id FROM tests WHERE full_name = ?').get(r.fullName).id;
}

function upsertError(db, fp, normalized, sample, seenAt) {
  if (!fp) return null;
  db.prepare(`
    INSERT INTO errors(fingerprint, normalized, sample, first_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO NOTHING
  `).run(fp, normalized, sample, seenAt);
  return db.prepare('SELECT id FROM errors WHERE fingerprint = ?').get(fp).id;
}

export function insertRun(db, run, results, fingerprintFn, normalizeFn) {
  const tx = () => {
    const info = db.prepare(`
      INSERT INTO runs(run_key, card, env, filter, started_at, elapsed_sec,
                       total, passed, failed, skipped, git_sha, git_branch, trx_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runKey, run.card, run.env, run.filter, run.startedAt, run.elapsedSec,
      run.counts.total, run.counts.passed, run.counts.failed, run.counts.skipped,
      run.gitSha, run.gitBranch, run.trxPath,
    );
    const runId = Number(info.lastInsertRowid);

    const insertResult = db.prepare(`
      INSERT INTO results(run_id, test_id, error_id, display_name, outcome,
                          duration_ms, message, stack)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of results) {
      const testId = upsertTest(db, r);
      const fp = fingerprintFn(r.message);
      const errId = upsertError(db, fp, normalizeFn(r.message), r.message, run.startedAt);
      insertResult.run(
        runId, testId, errId, r.displayName, r.outcome,
        r.durationMs, r.message, r.stack,
      );
    }
    return runId;
  };

  db.exec('BEGIN');
  try {
    const id = tx();
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------- read - */

export function lastRun(db, card, excludeRunKey = null) {
  return db.prepare(`
    SELECT * FROM runs
    WHERE card = ? AND (? IS NULL OR run_key <> ?)
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get(card, excludeRunKey, excludeRunKey) ?? null;
}

export function runByKey(db, runKey) {
  return db.prepare('SELECT * FROM runs WHERE run_key = ?').get(runKey) ?? null;
}

export function recentRuns(db, card, limit = 20) {
  return db.prepare(`
    SELECT * FROM runs
    WHERE (? IS NULL OR card = ?)
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(card, card, limit).reverse();
}

export function resultsForRun(db, runId) {
  return db.prepare(`
    SELECT r.*, t.full_name, t.short_name, e.fingerprint
    FROM results r
    JOIN tests t ON t.id = r.test_id
    LEFT JOIN errors e ON e.id = r.error_id
    WHERE r.run_id = ?
    ORDER BY (r.outcome = 'Failed') DESC, t.full_name
  `).all(runId);
}

export function failingNames(db, runId) {
  return db.prepare(`
    SELECT DISTINCT t.full_name, t.short_name
    FROM results r JOIN tests t ON t.id = r.test_id
    WHERE r.run_id = ? AND r.outcome = 'Failed'
    ORDER BY t.full_name
  `).all(runId);
}

/**
 * Per-test outcome sequence over the last N runs. Returned oldest-first so the
 * caller can render a pass/fail strip and count transitions.
 */
export function testSequences(db, card, limit = 20, env = null) {
  const rows = db.prepare(`
    WITH scoped AS (
      SELECT id, started_at FROM runs
      WHERE (? IS NULL OR card = ?)
        AND (? IS NULL OR env = ?)
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    )
    SELECT t.full_name, t.short_name, s.started_at, v.failed, v.cases, v.duration_ms
    FROM scoped s
    JOIN v_run_test v ON v.run_id = s.id
    JOIN tests t      ON t.id = v.test_id
    ORDER BY t.full_name, s.started_at ASC
  `).all(card, card, env, env, limit);

  const byTest = new Map();
  for (const r of rows) {
    if (!byTest.has(r.full_name)) {
      byTest.set(r.full_name, { fullName: r.full_name, shortName: r.short_name, seq: [] });
    }
    byTest.get(r.full_name).seq.push(r.failed === 1 ? 'X' : '.');
  }
  return [...byTest.values()];
}

/**
 * Groups a run's failures by error signature. N tests failing on one broken
 * helper collapse to a single row.
 */
export function errorClusters(db, runId) {
  return db.prepare(`
    SELECT e.fingerprint,
           COUNT(DISTINCT r.test_id) AS test_count,
           GROUP_CONCAT(DISTINCT t.short_name) AS tests,
           MIN(e.sample) AS sample,
           MIN(e.first_seen) AS first_seen
    FROM results r
    JOIN errors e ON e.id = r.error_id
    JOIN tests  t ON t.id = r.test_id
    WHERE r.run_id = ? AND r.outcome = 'Failed'
    GROUP BY e.fingerprint
    HAVING test_count > 1
    ORDER BY test_count DESC
  `).all(runId);
}

/**
 * For a test that is currently failing, finds the most recent run where it
 * passed and the run right after. With git metadata that brackets the commit
 * range that broke it.
 */
export function regressionWindow(db, fullName, card) {
  const lastPass = db.prepare(`
    SELECT ru.run_key, ru.started_at, ru.git_sha, ru.git_branch
    FROM runs ru
    JOIN v_run_test v ON v.run_id = ru.id
    JOIN tests t      ON t.id = v.test_id
    WHERE t.full_name = ? AND (? IS NULL OR ru.card = ?) AND v.failed = 0
    ORDER BY ru.started_at DESC LIMIT 1
  `).get(fullName, card, card);

  if (!lastPass) return { lastPass: null, firstFail: null };

  const firstFail = db.prepare(`
    SELECT ru.run_key, ru.started_at, ru.git_sha, ru.git_branch
    FROM runs ru
    JOIN v_run_test v ON v.run_id = ru.id
    JOIN tests t      ON t.id = v.test_id
    WHERE t.full_name = ? AND (? IS NULL OR ru.card = ?)
      AND v.failed = 1 AND ru.started_at > ?
    ORDER BY ru.started_at ASC LIMIT 1
  `).get(fullName, card, card, lastPass.started_at);

  return { lastPass, firstFail: firstFail ?? null };
}

export function slowestTests(db, card, limit = 10) {
  return db.prepare(`
    SELECT t.short_name, t.full_name,
           ROUND(AVG(v.duration_ms) / 1000.0, 1) AS avg_sec,
           COUNT(*) AS runs
    FROM v_run_test v
    JOIN runs  ru ON ru.id = v.run_id
    JOIN tests t  ON t.id = v.test_id
    WHERE (? IS NULL OR ru.card = ?)
    GROUP BY v.test_id
    HAVING avg_sec > 0
    ORDER BY avg_sec DESC
    LIMIT ?
  `).all(card, card, limit);
}
