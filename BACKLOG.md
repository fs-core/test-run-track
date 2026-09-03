# Backlog

## Seed database

Build out the Panorama seed DB so tests have something to provision against locally. Needs: correct schema, all static/lookup data (profile types, payment categories, org-type flags, `fs_internal.importfield` entries, enum rows). This is Layer 1 for everything below — nothing else is portable without it. Work was started but not finished.

## Local Docker environment for ECS E2E tests

Docker Compose image with Postgres (seeded from the seed DB above) and a local Floci instance, so ECS-triggering E2E tests can run on a dev machine without QA. Research first: audit Floci's AWS dependencies (SQS, S3, ECS task runner) and determine whether LocalStack covers them or whether a local execution mode is needed. If LocalStack: add it to the compose. If a local mode needs building: scope that separately.

## Test org provisioning — research and design

Research what provisioning a fresh org from scratch actually requires so the test suite can create/destroy its own org instead of sharing CATT and HanMaUm. Depends on seed DB being complete. Six areas to investigate:

1. **Org provisioning** — what rows are needed in `fs_internal.organization`, `fs_org.organization`, shard assignment, datasource entries; whether any of this goes through a service layer or can be done via SQL
2. **Org configuration** — payment method types, profile types, designation seed data, `workplaceid` flag; what is truly per-org vs. global
3. **`EnsureFieldGuidsAsync` hardening** — read this method; determine if it can be made safe for concurrent callers with `ON CONFLICT DO NOTHING` or needs to be hoisted to a suite-level one-time setup
4. **Import field mapping** — whether `fs_internal.importfield` rows are global or per-org; what a provisioned org needs to be importable
5. **App pool / ECS routing** — how the import pipeline resolves an org (by `organizationid`? S3 prefix? SQS routing key?); whether a freshly provisioned org is automatically routable or needs additional config
6. **Teardown** — whether deleting the org and all child rows is safe to do via SQL cascade, or whether there are cross-shard or external references that require a service call

Deliverable: a design doc (or annotated list of findings) that scopes the provisioning harness — the ~200–300 lines of C# that wraps this for tests.

## Duration-aware worker grouping

Second pass after parallel workers ship. Bin tests by historical `duration_ms` rather than count, so wall-clock time is balanced across workers. Requires accumulated run data — implement once there are enough parallel runs to work with.

## Data isolation validation

Before scaling parallel workers past 2–3, run a controlled test to confirm tests don't stomp each other's data (DB records, files, app pool sessions). If stomping is found, use chunk grouping as a mitigation — tests that share scaffolding go in the same worker.

## `end_time` on `results`

Capture the TRX `endTime` attribute and store it as `end_time TEXT` on the `results` table. Enables per-test "when did this last pass" queries without relying on `runs.started_at`. Schema bump + migration.
