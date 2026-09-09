# e2e — Playwright .NET runner with result history

Runs the E2E tests for a Jira card, stores every result in SQLite, and tells you
whether a failure is a new regression or a test that has always been flaky.

## Setup

Needs **Node 22.5+** (for the built-in `node:sqlite`). Check with `node --version`.

```
npm install
```

One dependency (`fast-xml-parser`, pure JS — no native build step).

Edit `e2e.config.json` if your project path differs:

```json
{
  "project": "C:\\code\\panorama\\qa\\fs_crm\\crm.web.Tests.E2E\\crm.web.Tests.E2E.csproj",
  "env": "qa"
}
```

Optional — put `e2e` on your PATH:

```
npm link
```

Otherwise use `node e2e.mjs ...` from this folder.

## Commands

```
e2e run PANK-1835                 run the card's tests
e2e run PANK-1835 --rerun         run only what failed last time
e2e run PANK-1835 --env staging   override E2E_ENV
e2e run PANK-1835 --html          also write an HTML report
e2e run PANK-1835 --workers 4     run the card's tests in parallel
e2e status PANK-1835              every known test, and when it last passed
e2e last PANK-1835                reprint the last run, execute nothing
e2e history PANK-1835             per-test pass/fail record
e2e history --flaky               flaky tests across all cards
e2e trend PANK-1835               run-over-run counts with git shas
e2e why PANK-1835 --test BulkTag  last-pass / first-fail commit range
e2e clusters PANK-1835            failures grouped by error signature
e2e clusters PANK-1835 --run KEY  clusters for one specific run
e2e slow PANK-1835                slowest tests by average duration
```

Flags: `--runs N` (history window, default 20), `--stack-lines N` (0 = all),
`--filter X` (bypass card matching), `--short` (use `Class.Method` in the rerun
filter instead of the full namespace), `--no-build`, `--env X` (also filters
`history` and `status`), `--all` (`status` only — every env, not just the
configured one).

`--workers N` splits the card's tests across N `dotnet test` processes (capped at
10), chunked by class so `OneTimeSetUp` never runs twice concurrently for the same
fixture. It is ignored when combined with `--filter` or `--rerun`, both of which
take the single-process path.

Exit codes: `0` all clear, `1` failures, `2` build/config problem, `3` filter matched no tests.

## How tests map to cards

`e2e run PANK-1835` becomes `--filter "FullyQualifiedName~PANK1835"` — punctuation
is stripped, so the card key must appear somewhere in the class or method name.
That matches what you're already doing.

If you'd rather use NUnit traits (`[Property("Jira", "PANK-1835")]`), change the
one line in `doRun` that builds the default filter to `Jira=${opts.card}`.

## Data

Everything lands in `%LOCALAPPDATA%\e2e-runner\`:

```
e2e.db                       SQLite database
PANK1835/<runkey>/*.trx      raw TRX per run, kept for reference
PANK1835/PANK1835-report.html
```

The DB is plain SQLite — query it directly whenever the built-in commands
aren't the shape you want:

```
sqlite3 %LOCALAPPDATA%\e2e-runner\e2e.db \
  "select card, run_key, git_sha, failed from runs order by started_at desc limit 10"
```

### Schema

| Table | Purpose |
|---|---|
| `runs` | one row per invocation: card, env, filter, counts, git sha/branch, elapsed |
| `tests` | stable identity per test (`full_name` unique) |
| `errors` | stable identity per failure signature (`fingerprint` unique) |
| `results` | one row per test case per run, FK to run/test/error |
| `v_run_test` | view collapsing data-driven cases: a test failed in a run if any case failed |

Error fingerprints come from normalizing the message — guids, numbers, quoted
strings, paths and urls are replaced with placeholders, then hashed. That's what
lets three tests failing on one broken login helper report as one problem.

`WAL` journal mode is on, so parallel CI jobs can write concurrently.

## Flaky vs regression

The verdict in `e2e history` counts *transitions*, not just failure rate:

```
BulkTagApplies              FLAKY            50%   5 flips  .X.X.X
DonorExportRespectsFilter   broke recently   50%   1 flip   ...XXX
```

Same 50% failure rate, completely different problems. The first is unstable; the
second broke at a specific point and stayed broken — and `e2e why` will hand you
the commit range for it.
