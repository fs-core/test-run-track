# Backlog

## Duration-aware worker grouping

Second pass after parallel workers ship. Bin tests by historical `duration_ms` rather than count, so wall-clock time is balanced across workers. Requires accumulated run data — implement once there are enough parallel runs to work with.

## Data isolation validation

Before scaling parallel workers past 2–3, run a controlled test to confirm tests don't stomp each other's data (DB records, files, app pool sessions). If stomping is found, use chunk grouping as a mitigation — tests that share scaffolding go in the same worker.

## `end_time` on `results`

Capture the TRX `endTime` attribute and store it as `end_time TEXT` on the `results` table. Enables per-test "when did this last pass" queries without relying on `runs.started_at`. Schema bump + migration.
