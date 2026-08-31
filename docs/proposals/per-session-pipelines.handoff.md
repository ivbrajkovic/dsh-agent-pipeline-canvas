# Handoff — per-session pipelines

Living log for [per-session-pipelines.md](per-session-pipelines.md). Read it
before starting a phase. Append an entry at the end of a phase ONLY when the
implementation materially diverged from the plan: what changed, and why.
Do not record anything the plan or the code already shows.

## Entries

- **S1 (commit b7ac95b, scrutinized post-implementation — verdict: ship; no
  blocking findings).** Two readings of the plan's wording the
  implementation pins, recorded so later phases keep them: (1) a session
  file that EXISTS but is malformed degrades to `pipeline: null` and does
  NOT fall through to the legacy graph — only ENOENT falls through
  (`readPipelineFile`'s `found` flag carries the distinction; falling
  through would resurrect the pre-fork graph after the session owns its
  file). (2) POST treats `sessionId: null`/`undefined` and `""` alike as
  absent → the legacy write, not a 400 (matches the stance's "without a
  `sessionId` (or with an empty one)" and the run route's coercion
  convention; S3's client sends a string or omits the field). Regression
  note: the malformed-no-fallthrough case lives only in the handler (no
  unit suite covers `index.ts`), so any future curl/browser matrix should
  include it — a corrupt `pipelines/<id>.json` must serve `null`, not the
  legacy graph.

- **S2 (commit e7726ba, scrutinized post-implementation — verdict: ship; no
  blocking findings).** One consequence of a plan pin, recorded so the S4
  docs sweep carries it: `getRun` stays unscoped ("a runId is a UUID
  address"), which keeps the run GET and SSE routes unscoped
  sweep/resurrect entry points — a lookup whose id has no live executor (a
  stale reconnect, a curl probe) lazily loads the workspace unscoped and
  can sweep or resurrect ANY session's records, so the control gate's
  session isolation is deliberately not airtight across those two routes.
  Session-scoped discovery through the pipeline GET (S2) and the client's
  per-session keying (S3) are the isolation path; the S4 route docs should
  state the run GET/SSE behavior explicitly.

- **S3 (scrutinized post-implementation — verdict: ship after one
  fix).** Three things the implementation carries beyond the plan's
  literal reset list, recorded so later phases don't undo them: (1) the
  switch reset also clears `resultOpen` and the node menu — clearing
  `runResult` alone leaves the previous session's open-modal flag set, so
  the NEXT session's restored `lastRun` would pop the result modal open
  on arrival, and the new graph can reuse the old session's node ids
  (an old menu would survive the vanish-guard). (2) The plan's reset
  cannot cover an IN-FLIGHT run start: a POST resolving after the switch
  would attach the old session's SSE (or pop its error modal) into the
  new session's view — `run()`'s resolution chain therefore compares
  `sessionIdRef` against the session captured at click time and bails
  (found by the post-implementation review; the save POST reads the same
  ref so both request scopes resolve at fire time, like `cwdRef`). (3)
  Matrix note for re-runs: with the shell panel open the backdrop covers
  the sidebar, so "switch sessions in the open panel" is not reachable by
  pointer clicks — exercise it through the harness's own session-switch
  action (a programmatic row click runs the identical code path). For the
  S4 sweep: the canvas toolbar's run-active strings still say "in this
  workspace" (deliberately untouched — S3's wording scope was the
  persistence wording).
