#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

import { parseTrx, buildRerunFilter, fingerprint, normalizeError } from './src/trx.mjs';
import { parseListTests, chunkByClass, buildWorkerFilter, mergeWorkerResults } from './src/parallel.mjs';
import * as db from './src/db.mjs';
import { buildHtmlReport } from './src/report.mjs';
import {
  red, green, yellow, blue, magenta, cyan, dim, bold,
  rule, thin, pad, indent, fmtElapsed, classify, verdictColor,
} from './src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// node:sqlite prints an ExperimentalWarning on every invocation. It's stable
// enough for our purposes and the noise buries the actual report.
const emit = process.emit;
process.emit = function (name, data) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message ?? '')) {
    return false;
  }
  return emit.apply(process, arguments);
};

/** Local-time run key: 20260902-160012 */
function runKeyNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ----------------------------------------------------------------- config - */

const DEFAULTS = {
  project: 'C:\\code\\panorama\\qa\\fs_crm\\crm.web.Tests.E2E\\crm.web.Tests.E2E.csproj',
  env: 'qa',
  resultsRoot: process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'e2e-runner')
    : join(homedir(), '.e2e-runner'),
};

function loadConfig() {
  const path = join(HERE, 'e2e.config.json');
  let file = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { console.error(yellow(`Ignoring malformed e2e.config.json: ${e.message}`)); }
  }
  return { ...DEFAULTS, ...file };
}

const cardKey = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function gitInfo(cwd) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return { sha: run(['rev-parse', '--short', 'HEAD']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

/* -------------------------------------------------------------------- run - */

function spawnWorker(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdout.on('data', () => {});  // drain stdout to prevent backpressure
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}

async function doRun(cfg, opts) {
  const card = cardKey(opts.card);
  if (!card) fail('Give me a Jira card, e.g. `e2e run PANK-1835`.');

  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));

  const workersOpt = opts.workers != null ? Math.min(Math.max(parseInt(opts.workers, 10) || 1, 1), 10) : null;

  // Parallel path: --workers N (N > 1) with no custom filter or rerun
  if (workersOpt && workersOpt > 1 && !opts.filter && !opts.rerun) {
    return doParallelRun(cfg, opts, card, database, workersOpt);
  }

  let filter;
  if (opts.filter) {
    filter = opts.filter;
  } else if (opts.rerun) {
    const prev = db.lastRun(database, card);
    if (!prev) fail(`No recorded runs for ${card}, so there is nothing to rerun.`);
    const failing = db.failingNames(database, prev.id);
    if (!failing.length) fail(`Last run of ${card} had no failures.`);
    filter = buildRerunFilter(
      failing.map((f) => ({ fullName: f.full_name, shortName: f.short_name })),
      { short: opts.short },
    );
    console.log(yellow(`Rerunning ${failing.length} previously failing test(s).`));
  } else {
    filter = `FullyQualifiedName~${card}`;
  }

  if (!existsSync(cfg.project)) fail(`Project not found: ${cfg.project}`);

  const previous = db.lastRun(database, card);
  const runKey = runKeyNow();
  const runDir = join(cfg.resultsRoot, card, runKey);
  mkdirSync(runDir, { recursive: true });
  const trxName = `${card}.trx`;
  const trxPath = join(runDir, trxName);

  const args = [
    'test', cfg.project,
    '--filter', filter,
    '--logger', `trx;LogFileName=${trxName}`,
    '--logger', 'console;verbosity=minimal',
    '--results-directory', runDir,
  ];
  if (opts['no-build']) args.push('--no-build');

  const started = new Date();
  console.log(`\n${rule()}\n  ${bold(card)}  |  env=${opts.env}  |  ${dim(started.toISOString())}\n${rule()}`);
  console.log(dim(`  filter : ${filter}`));
  console.log(dim(`  project: ${cfg.project}\n`));
  const proc = spawnSync('dotnet', args, {
    stdio: 'inherit',
    env: { ...process.env, E2E_ENV: opts.env },
  });
  const elapsedSec = (Date.now() - started.getTime()) / 1000;

  if (proc.error) fail(`Could not start dotnet: ${proc.error.message}`);

  if (!existsSync(trxPath)) {
    console.log(red('\n  No TRX produced - the build or test host failed. See output above.'));
    process.exit(2);
  }

  const { results, counts } = parseTrx(trxPath);
  const git = gitInfo(dirname(cfg.project));

  const runId = db.insertRun(database, {
    runKey, card, env: opts.env, filter,
    startedAt: started.toISOString(),
    elapsedSec, counts, trxPath,
    gitSha: git.sha, gitBranch: git.branch,
  }, results, fingerprint, normalizeError);

  report(database, runId, { card, env: opts.env, filter, elapsedSec, previous, cfg, opts });
  console.log(dim(`  done: ${new Date().toISOString()}\n`));
  // Exit 3, not 0, when the filter matched nothing. An empty run is a naming
  // problem, not a pass, and callers must not read it as green.
  process.exit(counts.failed > 0 ? 1 : counts.total === 0 ? 3 : 0);
}

async function doParallelRun(cfg, opts, card, database, requestedWorkers) {
  if (!existsSync(cfg.project)) fail(`Project not found: ${cfg.project}`);

  // Enumerate matching tests so we can split them into worker chunks.
  const listArgs = [
    'test', cfg.project,
    '--filter', `FullyQualifiedName~${card}`,
    '--list-tests',
  ];
  if (opts['no-build']) listArgs.push('--no-build');

  const started = new Date();
  console.log(`\n${rule()}\n  ${bold(card)}  |  env=${opts.env}  |  ${dim(started.toISOString())}\n${rule()}`);
  console.log(dim('  enumerating tests...'));
  const listProc = spawnSync('dotnet', listArgs, {
    encoding: 'utf8',
    env: { ...process.env, E2E_ENV: opts.env },
  });
  if (listProc.error) fail(`Could not start dotnet: ${listProc.error.message}`);

  const testNames = parseListTests(listProc.stdout ?? '')
    .filter((n) => n.toUpperCase().includes(card));
  if (!testNames.length) {
    console.log(yellow(`\n  No tests matched '${card}'.\n`));
    process.exit(3);
  }

  const chunks = chunkByClass(testNames, requestedWorkers);
  const actualWorkers = chunks.length;
  console.log(dim(`  ${testNames.length} test(s), ${actualWorkers} worker(s) (grouped by class)\n`));

  const previous = db.lastRun(database, card);
  const runKey = runKeyNow();
  const runDir = join(cfg.resultsRoot, card, runKey);
  mkdirSync(runDir, { recursive: true });

  const workerJobs = chunks.map((chunk, i) => {
    const workerDir = join(runDir, `worker-${i}`);
    mkdirSync(workerDir, { recursive: true });
    const args = [
      'test', cfg.project,
      '--filter', buildWorkerFilter(chunk),
      '--logger', `trx;LogFileName=${card}.trx`,
      '--results-directory', workerDir,
      '--no-build',  // list-tests already compiled
    ];
    return spawnWorker('dotnet', args, { ...process.env, E2E_ENV: opts.env })
      .then(({ code, stderr }) => {
        const elapsed = ((Date.now() - started.getTime()) / 1000).toFixed(0);
        console.log(dim(`  worker ${i} done  (${elapsed}s elapsed)`));
        return { i, trxPath: join(workerDir, `${card}.trx`), code, stderr };
      });
  });

  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - started.getTime()) / 1000).toFixed(0);
    console.log(dim(`  ... still running  ${new Date().toISOString()}  (${elapsed}s)`));
  }, 30_000);

  const workerResults = await Promise.all(workerJobs);
  clearInterval(heartbeat);
  const elapsedSec = (Date.now() - started.getTime()) / 1000;

  // Aggregate TRX results from all workers.
  const payloads = [];
  for (const { i, trxPath, code, stderr } of workerResults) {
    if (!existsSync(trxPath)) {
      console.log(red(`  Worker ${i} produced no TRX (exit ${code}).`));
      if (stderr) console.log(dim(stderr.slice(0, 500)));
    } else {
      payloads.push(parseTrx(trxPath));
    }
  }

  if (!payloads.length) {
    console.log(red('\n  No TRX produced by any worker.\n'));
    process.exit(2);
  }

  const { results, counts } = mergeWorkerResults(payloads);
  const git = gitInfo(dirname(cfg.project));

  const runId = db.insertRun(database, {
    runKey, card, env: opts.env, filter: `FullyQualifiedName~${card}`,
    startedAt: started.toISOString(),
    elapsedSec, counts, trxPath: runDir,
    gitSha: git.sha, gitBranch: git.branch,
    workers: actualWorkers,
  }, results, fingerprint, normalizeError);

  report(database, runId, { card, env: opts.env, filter: `FullyQualifiedName~${card}`, elapsedSec, previous, cfg, opts });
  console.log(dim(`  done: ${new Date().toISOString()}\n`));
  process.exit(counts.failed > 0 ? 1 : counts.total === 0 ? 3 : 0);
}

/* ----------------------------------------------------------------- report - */

function report(database, runId, ctx) {
  const { card, env, filter, elapsedSec, previous, cfg, opts } = ctx;
  const rows = db.resultsForRun(database, runId);
  const failed = rows.filter((r) => r.outcome === 'Failed');
  const passed = rows.filter((r) => r.outcome === 'Passed');
  const skipped = rows.filter((r) => !['Passed', 'Failed'].includes(r.outcome));

  const verdict = rows.length === 0 ? 'NO TESTS MATCHED'
    : failed.length === 0 ? 'ALL CLEAR'
    : `${failed.length} FAILING`;
  const paint = rows.length === 0 ? yellow : failed.length === 0 ? green : red;

  console.log(`\n${rule()}\n  ${bold(`RESULTS  ${card}`)}\n${rule()}\n`);
  console.log(`  ${paint(bold(verdict))}`);
  console.log(dim(`  ${rows.length} total   ${passed.length} passed   ${failed.length} failed   ` +
    `${skipped.length} skipped   ${fmtElapsed(elapsedSec)} elapsed`));

  if (rows.length === 0) {
    console.log(yellow(`\n  Nothing matched '${filter}'.`));
    console.log(dim(`  Check that a class or method name contains '${card}'.`));
  }

  // ---- failures
  if (failed.length) {
    console.log(`\n  ${red(bold('FAILURES'))}\n  ${thin()}`);
    failed.forEach((f, i) => {
      console.log(`\n  ${red(`[${i + 1}] ${f.display_name}`)}`);
      if (f.message) {
        console.log(dim('      error:'));
        indent(f.message).forEach((l) => console.log(yellow(l)));
      }
      if (f.stack) {
        const lines = f.stack.split(/\r?\n/).filter((l) => l.trim());
        const limit = Number(opts['stack-lines'] ?? 12);
        const show = limit > 0 ? lines.slice(0, limit) : lines;
        console.log(dim('      stack:'));
        show.forEach((l) => console.log(dim(`      ${l.trim()}`)));
        if (limit > 0 && lines.length > limit) {
          console.log(dim(`      ... ${lines.length - limit} more frame(s) - use --stack-lines 0`));
        }
      }
    });
  }

  // ---- diff vs previous run
  if (previous) {
    const prevFailing = new Set(db.failingNames(database, previous.id).map((r) => r.full_name));
    const nowFailing = new Set(failed.map((r) => r.full_name));
    const regressions = [...nowFailing].filter((n) => !prevFailing.has(n));
    const fixed = [...prevFailing].filter((n) => !nowFailing.has(n));
    const still = [...nowFailing].filter((n) => prevFailing.has(n));

    console.log(`\n  ${cyan(bold('SINCE PREVIOUS RUN'))} ${dim(`(${previous.run_key}` +
      `${previous.git_sha ? `, ${previous.git_sha}` : ''})`)}\n  ${thin()}`);
    if (!regressions.length && !fixed.length) console.log(dim('      no change in which tests are failing'));
    regressions.forEach((n) => console.log(red(`      NEW FAILURE  ${n}`)));
    fixed.forEach((n) => console.log(green(`      FIXED        ${n}`)));
    still.forEach((n) => console.log(yellow(`      still red    ${n}`)));
  }

  // ---- flake vs regression
  const seqs = db.testSequences(database, card, 20);
  const flaky = seqs
    .map((s) => ({ ...s, ...classify(s.seq) }))
    .filter((s) => s.verdict === 'FLAKY' && s.last === 'X');
  if (flaky.length) {
    console.log(`\n  ${yellow(bold('LOOKS FLAKY, NOT NEW'))}\n  ${thin()}`);
    flaky.forEach((f) => console.log(yellow(
      `      ${pad(f.shortName, 44)} ${f.failures}/${f.runs} runs, ${f.flips} flips  [${f.pattern}]`)));
  }

  // ---- shared root cause
  const clusters = db.errorClusters(database, runId);
  if (clusters.length) {
    console.log(`\n  ${cyan(bold('SHARED ROOT CAUSE'))}\n  ${thin()}`);
    clusters.forEach((c) => {
      const first = (c.sample ?? '').split(/\r?\n/)[0].trim().slice(0, 90);
      console.log(cyan(`      ${c.test_count} tests, same signature ${dim(c.fingerprint)}: ${first}`));
      console.log(dim(`        ${c.tests}`));
    });
  }

  // ---- rerun filter
  const rerunFilter = buildRerunFilter(
    failed.map((f) => ({ fullName: f.full_name, shortName: f.short_name })),
    { short: opts.short },
  );
  if (rerunFilter) {
    console.log(`\n  ${magenta(bold('RERUN FILTER'))}\n  ${thin()}\n`);
    console.log(`  ${rerunFilter}\n`);
    console.log(dim('  ready-to-paste:'));
    console.log(cyan(`  $env:E2E_ENV = "${env}"; dotnet test "${cfg.project}" ` +
      `--filter "${rerunFilter}" --logger "console;verbosity=detailed"`));
    console.log(dim(`\n  or: e2e run ${card} --rerun`));
  }

  if (opts.html) {
    const out = join(cfg.resultsRoot, card, `${card}-report.html`);
    buildHtmlReport({ card, env, filter, rows, rerunFilter, elapsedSec, clusters, out });
    console.log(dim(`\n  report: ${out}`));
  }
  console.log(dim(`\n  db: ${join(cfg.resultsRoot, 'e2e.db')}\n`));
}

/* -------------------------------------------------------------- queries -- */

function doHistory(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const card = opts.card ? cardKey(opts.card) : null;
  const limit = Number(opts.runs ?? 20);
  const stats = db.testSequences(database, card, limit, opts.env ?? null)
    .map((s) => ({ ...s, ...classify(s.seq) }))
    .filter((s) => (opts.flaky ? s.verdict === 'FLAKY' || s.verdict === 'intermittent' : true))
    .sort((a, b) => b.flips - a.flips || b.failPct - a.failPct || a.shortName.localeCompare(b.shortName));

  if (!stats.length) return console.log(yellow('\n  Nothing matched.\n'));

  console.log(`\n  ${bold(`TEST RECORD - ${card ?? 'all cards'}, last ${limit} run(s)`)}`);
  console.log(dim('  oldest run on the left; . = passed, X = failed'));
  console.log(`  ${dim('-'.repeat(94))}`);
  console.log(dim(`  ${pad('TEST', 44)} ${pad('VERDICT', 16)} ${pad('FAIL%', 6)} ${pad('FLIPS', 6)} PATTERN`));
  for (const s of stats) {
    const paint = verdictColor(s.verdict);
    console.log(`  ${paint(pad(s.shortName, 44))} ${paint(pad(s.verdict, 16))} ` +
      `${pad(s.failPct + '%', 6)} ${pad(s.flips, 6)} ${s.pattern}`);
  }
  console.log('');
}

function doTrend(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const rows = db.recentRuns(database, opts.card ? cardKey(opts.card) : null, Number(opts.runs ?? 20));
  if (!rows.length) return console.log(yellow('\n  No runs recorded.\n'));
  console.log(`\n  ${dim(`${pad('RUN', 17)} ${pad('CARD', 10)} ${pad('ENV', 7)} ${pad('SHA', 9)} ` +
    `${pad('TOTAL', 6)} ${pad('PASS', 6)} ${pad('FAIL', 6)} ELAPSED`)}`);
  console.log(`  ${dim('-'.repeat(80))}`);
  for (const r of rows) {
    const paint = r.failed > 0 ? red : green;
    console.log(`  ${paint(pad(r.run_key, 17))} ${pad(r.card, 10)} ${pad(r.env, 7)} ` +
      `${pad(r.git_sha ?? '-', 9)} ${pad(r.total, 6)} ${pad(r.passed, 6)} ${pad(r.failed, 6)} ` +
      fmtElapsed(r.elapsed_sec));
  }
  console.log('');
}

function doWhy(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const card = opts.card ? cardKey(opts.card) : null;
  const needle = opts.test;
  if (!needle) fail('Give me a test name: `e2e why PANK-1835 --test BulkTagApplies`');

  const matches = database.prepare(
    'SELECT full_name, short_name FROM tests WHERE full_name LIKE ? ORDER BY full_name',
  ).all(`%${needle}%`);
  if (!matches.length) return console.log(yellow(`\n  No test matching '${needle}'.\n`));

  for (const m of matches) {
    const { lastPass, firstFail } = db.regressionWindow(database, m.full_name, card);
    console.log(`\n  ${bold(m.short_name)}`);
    if (!lastPass) {
      console.log(yellow('      never passed in recorded history'));
    } else if (!firstFail) {
      console.log(green(`      passing as of ${lastPass.run_key}` +
        `${lastPass.git_sha ? ` (${lastPass.git_sha})` : ''}`));
    } else {
      console.log(green(`      last passed  ${lastPass.run_key}  ` +
        `${lastPass.git_sha ?? '?'}  ${lastPass.git_branch ?? ''}`));
      console.log(red(`      first failed ${firstFail.run_key}  ` +
        `${firstFail.git_sha ?? '?'}  ${firstFail.git_branch ?? ''}`));
      if (lastPass.git_sha && firstFail.git_sha) {
        console.log(dim(`\n      suspect range: git log --oneline ${lastPass.git_sha}..${firstFail.git_sha}`));
      }
    }
  }
  console.log('');
}

function doClusters(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const card = cardKey(opts.card);
  const run = opts.run ? db.runByKey(database, opts.run) : db.lastRun(database, card);
  if (!run) return console.log(yellow('\n  No run found.\n'));
  const clusters = db.errorClusters(database, run.id);
  if (!clusters.length) return console.log(dim(`\n  No shared error signatures in ${run.run_key}.\n`));
  console.log(`\n  ${bold(`ERROR CLUSTERS - ${run.run_key}`)}\n  ${thin()}`);
  for (const c of clusters) {
    console.log(cyan(`\n  ${c.test_count} tests  ${dim(c.fingerprint)}  first seen ${c.first_seen?.slice(0, 10)}`));
    indent(c.sample, 6, 96).slice(0, 6).forEach((l) => console.log(yellow(l)));
    console.log(dim(`      affects: ${c.tests}`));
  }
  console.log('');
}

function doSlow(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const rows = db.slowestTests(database, opts.card ? cardKey(opts.card) : null, Number(opts.runs ?? 10));
  if (!rows.length) return console.log(yellow('\n  No timing data yet.\n'));
  console.log(`\n  ${bold('SLOWEST TESTS (avg)')}\n  ${thin()}`);
  for (const r of rows) console.log(`  ${pad(r.short_name, 50)} ${String(r.avg_sec).padStart(7)}s  ${dim(`${r.runs} runs`)}`);
  console.log('');
}

function doLast(cfg, opts) {
  const database = db.openDb(join(cfg.resultsRoot, 'e2e.db'));
  const card = cardKey(opts.card);
  const run = db.lastRun(database, card);
  if (!run) return console.log(yellow(`\n  No runs recorded for ${card}.\n`));
  const previous = db.lastRun(database, card, run.run_key);
  report(database, run.id, {
    card, env: run.env, filter: run.filter,
    elapsedSec: run.elapsed_sec, previous, cfg, opts,
  });
}

/* ------------------------------------------------------------------- cli -- */

function fail(msg) { console.error(red(`\n  ${msg}\n`)); process.exit(2); }

const USAGE = `
  e2e - Playwright .NET E2E runner with result history

  e2e run <CARD> [--env qa] [--rerun] [--filter X] [--html] [--no-build]
                 [--stack-lines N] [--short] [--workers N]
  e2e last <CARD>              reprint the last run, no tests executed
  e2e history [CARD] [--runs N] [--flaky] [--env qa]
  e2e trend [CARD] [--runs N]
  e2e why <CARD> --test <name> last-pass / first-fail with git shas
  e2e clusters <CARD> [--run KEY]
  e2e slow [CARD] [--runs N]

  The database is plain SQLite - query it directly any time:
    sqlite3 %LOCALAPPDATA%\\e2e-runner\\e2e.db "select * from runs order by started_at desc limit 5"
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    env: { type: 'string' },
    filter: { type: 'string' },
    runs: { type: 'string' },
    test: { type: 'string' },
    run: { type: 'string' },
    'stack-lines': { type: 'string' },
    rerun: { type: 'boolean' },
    flaky: { type: 'boolean' },
    html: { type: 'boolean' },
    short: { type: 'boolean' },
    'no-build': { type: 'boolean' },
    workers: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cfg = loadConfig();
const [cmd, cardArg] = positionals;
const opts = { ...values, card: cardArg, env: values.env ?? cfg.env };

if (values.help || !cmd) { console.log(USAGE); process.exit(0); }

try {
  switch (cmd) {
    case 'run': await doRun(cfg, opts); break;
    case 'last': doLast(cfg, opts); break;
    case 'history': doHistory(cfg, opts); break;
    case 'trend': doTrend(cfg, opts); break;
    case 'why': doWhy(cfg, opts); break;
    case 'clusters': doClusters(cfg, opts); break;
    case 'slow': doSlow(cfg, opts); break;
    default: fail(`Unknown command '${cmd}'.${USAGE}`);
  }
} catch (e) {
  fail(e.stack ?? e.message);
}
