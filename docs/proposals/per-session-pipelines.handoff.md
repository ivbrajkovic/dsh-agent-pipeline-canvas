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
