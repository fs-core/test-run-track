# e2e-runner — maintenance notes

This is a CLI that runs Playwright .NET E2E tests per Jira card, stores results
in SQLite, and distinguishes flaky tests from real regressions.

**Scope: you maintain this codebase. You do not run the tests.** The human runs
`e2e run <CARD>` themselves against the real Panorama CRM suite. Don't invoke
`dotnet`, don't try to run E2E tests, and don't treat a missing .NET SDK as a
problem to solve — it's expected.

## Verify loop

There is no .NET SDK here, so the `dotnet test` spawn cannot be exercised.
Everything downstream of it is covered by synthetic TRX fixtures:

```
npm test
```

**Run this before you start and after every change.** 29 tests, under a second.
If you change parsing, fingerprinting, filter building, verdicts, or SQL, the
suite is the only thing standing between a subtle break and the human finding
out three weeks later that reruns silently match nothing.

Adding behaviour means adding a test. `test/fixtures.mjs` builds synthetic TRX;
extend it rather than hand-writing XML inline.

## Layout

| File | Responsibility |
|---|---|
| `e2e.mjs` | CLI: arg parsing, the `dotnet` spawn, console report rendering, subcommand dispatch |
| `src/trx.mjs` | TRX XML to flat result records; error normalization; rerun-filter construction |
| `src/db.mjs` | Schema DDL, inserts, and every query |
| `src/render.mjs` | ANSI colour, padding, `classify()` verdict logic |
| `src/report.mjs` | Standalone HTML report |
| `test/` | Fixtures + suite |

## Invariants

Break any of these and the tool fails quietly rather than loudly. Each has a
test guarding it — if you find yourself changing the test to match new
behaviour, stop and ask.

1. **`fullName` never contains data-driven arguments.** It feeds the rerun
   filter. `BulkTagApplies("bulk",25)` must reduce to `...BulkTagApplies`, or
   the generated `FullyQualifiedName~` matches nothing and the rerun looks like
   a pass. `displayName` keeps the arguments, for humans.
2. **Exit codes are a contract**: `0` all clear, `1` failures, `2` build or
   config problem, `3` filter matched no tests. `3` exists specifically because
   an empty run returning `0` reads as green to any caller. Never collapse it.
3. **Aggregate per-test history through `v_run_test`, never `results`
   directly.** A data-driven test writes one `results` row per case; querying
   `results` counts it several times per run and corrupts every rate and pattern.
4. **The XML parser needs `isArray` for `UnitTest` and `UnitTestResult`.**
   Without it, a run containing exactly one test returns an object instead of an
   array and every downstream `.map()` throws.
5. **Error normalization must mask numbers with unit suffixes.** `\b\d+\b` does
   not match `30000` in `30000ms` — there is no word boundary between a digit and
   a letter. This was a live bug; the current pattern has no `\b` for that reason.
6. **`classify()` counts transitions, not failure rate.** `.X.X.X` and `...XXX`
   are both 50% failures but are a flake and a regression respectively. That
   distinction is the main reason this tool exists.

## Conventions

- ESM throughout (`"type": "module"`). No CommonJS, no transpiler, no bundler.
- **Exactly one runtime dependency** (`fast-xml-parser`, pure JS). Do not add
  dependencies without asking — especially anything with a native build step.
  SQLite comes from the built-in `node:sqlite`, which is why Node 22.5+ is
  required and why the ExperimentalWarning is suppressed in `e2e.mjs`.
- SQL uses positional `?` parameters throughout. Keep it consistent.
- Paths are Windows-first (`%LOCALAPPDATA%`), with a POSIX fallback so the tests
  run anywhere. Preserve both.
- Console output is plain ASCII with ANSI colour, and colour is disabled when
  not a TTY or when `NO_COLOR` is set. Don't introduce box-drawing or emoji.
- The HTML report uses the FrontStream palette (teal `#1E4854`, green `#07A279`,
  orange `#DF7543`) and DM Sans. Leave those alone unless asked.

## Schema changes

`SCHEMA_VERSION` lives at the top of `src/db.mjs` and is written to the `meta`
table. The DDL is `CREATE TABLE IF NOT EXISTS`, so additive changes are safe.

For anything destructive or restructuring: bump `SCHEMA_VERSION`, write an
explicit migration keyed off the stored value, and never drop a table that holds
run history. That history is the product — a user's accumulated flakiness data
cannot be regenerated. If a change would lose it, say so before doing it.

WAL journal mode is deliberate, so parallel CI jobs can write concurrently.

## Known soft spots

- The `dotnet test` spawn in `doRun` is untested. Changes there need careful
  reading and should be flagged to the human for a manual run.
- Card-to-test matching is substring-based (`FullyQualifiedName~PANK1835`), so
  the card key must appear in a class or method name. Moving to NUnit traits
  (`Jira=PANK-1835`) is a one-line change in `doRun` if asked.
- `errorClusters` requires `test_count > 1`, so a single test failing alone
  never shows a cluster. That is intentional.

## Don't

- Don't run E2E tests or invoke `dotnet`.
- Don't delete or hand-edit any `e2e.db`; it is never committed and lives in
  `%LOCALAPPDATA%\e2e-runner\`.
- Don't weaken a test to make a change pass.
- Don't reformat files you aren't otherwise touching.
