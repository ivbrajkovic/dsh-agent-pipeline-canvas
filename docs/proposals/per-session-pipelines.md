# Per-session pipelines — every session owns its graph

**Status: Planned** — four phases (S1 Host storage, S2 Host run keying,
S3 client keying + browser verification, S4 docs + status flip). Reviewed
via the scrutinize pass before implementation (verdict: fix-then-ship;
findings applied — the S3 session-switch reset, the session-id wording, the
S2 control-read gate, and the sweep pattern). The living
phase-delta handoff lives in
[per-session-pipelines.handoff.md](per-session-pipelines.handoff.md).

Today every session in a workspace shares ONE pipeline: the graph lives at
`<workspace>/.agent-pipeline/pipeline.json` and the single-active-run rule is
per workspace. The UI is already per-session — the Pipelines tab and the
shell panel both bind to the current session, and every run record already
carries the `sessionId` it was started from — but storage and run keying hang
off the workspace cwd alone. This plan gives each DSH session its own
pipeline graph and its own active-run slot, while keeping the legacy
workspace file working byte-identically for anything that does not name a
session.

## Design stance (pinned)

- **Copy-on-write fork, not eager copy.** A session-scoped GET falls back to
  the legacy `pipeline.json` while the session has no file of its own; the
  FIRST session-scoped save writes `<cwd>/.agent-pipeline/pipelines/<sessionId>.json`
  and from that moment the session reads its own file. A session that merely
  opens the tab never writes anything — neither the GET nor any load path
  creates a file; the fork fires only when an EDIT lands in that session
  (placing an agent, connecting, deleting, clearing, moving a node — any
  change the view persists through its debounced save). Pre-existing
  sessions are NEVER backfilled: an old session with no file of its own
  keeps the read-through indefinitely — no entry is created for old
  sessions, at open or at any other time.
  Rejected: eager copy on load (litters the repo with files for sessions
  that never touched the canvas) and blank-start (cuts a new session off
  from the repo's existing pipeline for no benefit).
- **Legacy requests stay byte-identical.** A GET/POST without a `sessionId`
  (or with an empty one) behaves exactly as today — reads/writes the shared
  `pipeline.json`, returns workspace-level `run`/`lastRun`. This is the
  curl-able contract, the graceful degrade when a client has no session id,
  and the compatibility path for the current committed `lib/`.
- **Runs key off the record's existing `sessionId` — no schema change.**
  Every v2 record already persists `sessionId` (set by `startRun`, which
  requires a live session agent). What changes is filtering: discovery
  (`activeRunForCwd` / `latestRunForCwd`), the single-active-run rule, and
  the lazy disk sweep become session-scoped when asked. One active run per
  (cwd, **session**); two sessions in one workspace may run concurrently.
  Every record this code has written carries the id (`startRun` has
  required a non-empty `sessionId` since the first durable-run commit), so
  the scoping is filtering, not migration; defensively, a record with a
  MISSING `sessionId` is invisible to scoped queries and stays visible
  only through the unscoped legacy path.
- **Session key validation.** Only `[A-Za-z0-9][A-Za-z0-9_-]*`, capped at
  128 characters, is accepted as a session key. The REGEX is the guarantee —
  shape-agnostic and independent of any harness id format (live ids are
  `session-<uuid>` shaped and pass; the harness also accepts
  caller-supplied ids, which is exactly why the rule does not assume a
  UUID). It excludes path separators, so with the `.json` suffix appended
  verbatim there is no traversal surface — the same trust discipline as the
  existing cwd refusal — and the cap keeps an absurd key from dying as
  ENAMETOOLONG → 500. Anything else → `400`.
- **Storage layout** — one new directory, nothing moves:
  ```
  <cwd>/.agent-pipeline/pipeline.json               legacy shared graph (unchanged; fork source)
  <cwd>/.agent-pipeline/pipelines/<sessionId>.json  per-session graph (the fork point)
  <cwd>/.agent-pipeline/runs/<runId>.json           run records (unchanged location; sessionId already on the record)
  ```
- **Consequence, documented not solved:** concurrent runs in one workspace
  are now possible (different sessions), so two pipelines' agents can touch
  the same repo files at the same time. That is the point of the feature;
  the guides carry the caveat. Deleted sessions leave orphan files under
  `pipelines/` — a recorded known limit (same standing as the run-operations
  known limits), not in scope.

## Working context (read before starting any phase)

- **Where things live** — `src/index.ts`: `pipelinePath` (~line 153), the
  GET/POST persistence handler (~lines 226/261), the `PIPELINE_DIR` /
  `PIPELINE_FILE` constants (~lines 88-89). `src/storage.ts`: `writeAtomic`
  (the protocol every write shares) — the new path helpers belong here, so
  they are pure and unit-testable. `src/runs.ts`: `RUNS_DIR` (~line 148),
  `recordPath` (~line 286), `startRun` with the per-workspace 409 checks
  (~lines 1571-1633), `activeRunForCwd` (~line 1640), `latestRunForCwd`
  (~line 1665), `getRun` (~line 1701), `control` (~line 1729),
  `loadFromDisk` (~line 1774), `sweepOrResurrect` (~line 1807).
  `src/ui/pipeline-view.tsx`: the load effect (~lines 754-827, deps
  `[cwd]`), the debounced save effect (~lines 832-847, POST body at ~844).
  `src/ui/shell-panel.tsx`: the "stored per workspace" wording (~line 128).
  Discovery consumers: the load effect's `run` / `lastRun` adoption
  (~lines 806-823) needs no logic change once the GET is session-scoped.
- **Research discipline** — use Codebase Memory for any project or DeepSeek
  Harness research (`search_graph` → `trace_path` → `get_code_snippet`;
  `check_index_coverage` for every file relied on). The harness repository
  (`~/Desktop/deepseek-harness`) is the source of truth for session and
  subagent behavior and is READ-ONLY: inspect it, never modify it. All
  implementation changes stay in this repository.
- **Verification baseline** — `pnpm typecheck`, `pnpm test` (five pure-logic
  suites; 252 checks green at planning time, commit bda5265) and
  `pnpm build` are green and MUST stay green at every phase gate. `lib/` is
  committed build output — rebuild every phase so the bundle ships with the
  source. Host-half phases (S1, S2) need a web-profile host restart to
  remount routes; client-only phases (S3) need just a hard browser refresh.
- **Browser verification recipe (every phase that touches UI)** — use the
  Chrome DevTools skill, ATTACHED TO THE EXISTING running Chrome
  window/tab (never a new browser instance). `pnpm build`, hard-refresh the
  DSH Web tab, then exercise the flows listed in the phase.
- **Commits** — one commit per phase, each leaving the tree green. This
  plan's registration (the index.md row plus the two
  `docs/proposals/per-session-pipelines*` files) is its own commit, made
  before S1.
- **Handoff discipline** — read
  [per-session-pipelines.handoff.md](per-session-pipelines.handoff.md)
  BEFORE starting a phase; append an entry AFTER a phase only when the
  implementation materially diverged from the plan (what changed, why).

## S1 — Host storage: the per-session pipeline file + read-through fallback

**Scope.** The persistence route only. A session-scoped GET returns the
session's own graph when it exists and the legacy `pipeline.json` when it
does not; a session-scoped POST writes the session's file (the fork). No
run logic changes.

**Implementation.**

1. `src/storage.ts` — add and export the path seam:
   - `isValidSessionKey(key: unknown): key is string` — the charset rule
     above (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) plus the 128-character cap.
   - `sessionPipelineFilePath(cwd: unknown, sessionId: unknown): string | null`
     — `join(cwd, ".agent-pipeline", "pipelines", sessionId + ".json")`,
     returning null when `cwd` fails the existing absolute-path rule or the
     key fails `isValidSessionKey`. Mirrors `pipelinePath`'s doc contract
     (the literal suffix appended verbatim; no traversal surface).
   - Keep `writeAtomic` untouched; both files write through it.
   - Update the module-header artifact list (it enumerates what the module
     persists — the per-session path seam joins it).
2. `src/index.ts` — the persistence handler:
   - **GET**: read `sessionId` from the query. When present and valid,
     resolve `sessionPipelineFilePath`; read that file (ENOENT → fall back
     to the legacy `pipeline.json` read, both degrading to `null` on
     missing/malformed exactly as today). When the key is present but
     INVALID, answer `400 invalid or missing sessionId`. When absent/empty,
     the current behavior byte-identical. The `validation`, `run`, and
     `lastRun` fields keep their current semantics in this phase (run
     scoping lands in S2).
   - **POST**: when `sessionId` is present, validate it (400 on invalid),
     `mkdir` the `pipelines` directory recursively, and `writeAtomic` the
     session file; when absent/empty, write the legacy file as today.
   - Update the module-header comments: the route list, the storage
     paragraph, and the line-4 "durable per repository" phrase.
3. No changes to `runs.ts`, the client, or the graph schema.

**Testing and verification.**

- New `test/storage.test.ts`: `isValidSessionKey` accepts a UUID-shaped id
  and plain alphanumerics; rejects empty, `.`, `..`, `../x`, `a/b`, `a\b`,
  non-strings; `sessionPipelineFilePath` returns the expected path under
  `<cwd>/.agent-pipeline/pipelines/` and null for a relative/empty cwd or a
  bad key. Follow the existing suites' `okCheck` style.
- `pnpm typecheck && pnpm test && pnpm build` — all green, baseline count
  plus the new checks.
- Restart the web-profile host, then curl the matrix: POST with a
  `sessionId` writes `pipelines/<id>.json` and leaves `pipeline.json`
  untouched; GET with that id returns it; GET with a different session id
  (no file) returns the legacy graph AND creates nothing under
  `pipelines/` (a bare GET is never a fork); GET/POST without `sessionId`
  behave exactly as before; an invalid key (`../x`) answers 400.

## S2 — Host runs: session-scoped active-run rule and discovery

**Scope.** The run registry. The single-active-run rule becomes per
(cwd, session); discovery and the lazy disk sweep become session-scoped when
asked; the legacy unscoped path keeps today's behavior. No record-schema
change and no route-contract change (the routes gain only the GET's
`sessionId` pass-through).

**Implementation.**

1. `src/runs.ts`:
   - `loadFromDisk(cwd, sessionId?)` — with a session key, skip records
     whose `rec.sessionId !== sessionId` (legacy v1 records without
     `sessionId` are invisible to scoped queries); sweep/resurrect/active
     -pick operate only on the surviving set. Without a key, today's
     behavior exactly.
   - `activeRunForCwd(cwd, sessionId?)` and `latestRunForCwd(cwd,
     sessionId?)` — filter the in-memory executor loops by
     `rec.sessionId` when scoped, pass the scope to `loadFromDisk` /
     the disk scans.
   - `startRun` — the single-active-run checks scope to the REQUEST's
     session: in-memory `executor.record.cwd === cwd &&
     executor.record.sessionId === sessionId`; disk check
     `loadFromDisk(cwd, sessionId)`. Wording: "another run is already
     active in this session" (no test asserts the old string).
   - `control` — before the resurrect sweep, read the target record file
     (best-effort) to learn its `sessionId` — only when no live executor
     holds the runId, mirroring the existing gate, so a live control
     command pays no disk read — then sweep with
     `loadFromDisk(validCwd, thatSessionId)` so session A's control command
     does not resurrect session B's paused run. Unreadable file → skip the
     sweep; the existing "no run / not controllable" errors stand.
   - `getRun` stays unscoped (a runId is a UUID address; the debug route
     and SSE lookups are by exact id).
   - Update the module-header wording (one active run per session).
2. `src/index.ts` — the persistence GET passes a valid `sessionId` query
   parameter into `activeRunForCwd` / `latestRunForCwd` (invalid key still
   400 from S1). The run, events, and control routes are unchanged.
3. `src/types.ts` — the comment that says "one run is active per workspace"
   (~line 397) moves to per session.

**Testing and verification.**

- Extend `test/runs.test.ts` (the single-active section at ~line 790 and
  the discovery sections): same session second start → 409 with the active
  id (existing checks stay green); different sessions, same cwd → both
  start, each `activeRunForCwd(cwd, sid)` reports only its own, and the
  409 fires only within one session; `latestRunForCwd` filters by session;
  scoped `loadFromDisk` leaves ANOTHER session's stale `running` record
  untouched on disk and sweeps only its own (the unscoped call still
  sweeps both); a MISSING-`sessionId` record is invisible to scoped
  discovery but still served by the unscoped path (hand-crafted through
  `unknown` — no real record lacks the id, the tolerance is defensive).
- `pnpm typecheck && pnpm test && pnpm build` — green.
- Restart the host. Browser-level concurrency verification is S3's gate;
  here a curl check suffices: two `POST /run`s with different `sessionId`s
  both answer `{ ok: true }`; a second run for the SAME session answers
  409 with the active id.
- Known transitional window, accepted: between S2 and S3's refreshed
  client, the served legacy client's workspace-level GET still discovers
  runs unscoped and can adopt the newest active run of ANY session in the
  workspace. The window closes at S3's browser refresh; acceptable in the
  single-developer flow.

## S3 — Client: per-session load/save, restore, and wording

**Scope.** The browser half. The view loads, saves, and restores per
session; the wording stops claiming the graph is stored per workspace. No
execution or schema change; the run-start payload already carries
`sessionId`.

**Implementation.**

1. `src/ui/pipeline-view.tsx`:
   - Load effect: append `&sessionId=` (encoded) when the prop is non-empty;
     dependency array `[cwd]` → `[cwd, sessionId]`. The effect now REFIRES
     on a session switch (the shell panel stays mounted across switches),
     so the (re)entry path must reset the per-run view state the previous
     session left behind: `disconnectRunEvents()` (a stale EventSource
     keeps calling `setActiveRun` for the previous session's run),
     `setActiveRun(null)`, reset `doneRun` / `runResult`, and clear a
     pending debounced save (`saveTimerRef`) — a timer scheduled for the
     old session that fires after the switch writes the OLD graph into the
     NEW session's file (the callback reads `stateRef.current` at fire
     time). The run / `lastRun` adoption machinery at ~lines 806-823 and
     the `skipNextPersist` / `loadedRef` handling are unchanged — the
     GET's semantics are already session-scoped after S2.
   - Save effect: POST body `{ cwd, sessionId?, graph }` — include the key
     when non-empty. An empty key (no session context) keeps the legacy
     cwd-only request, matching the Host's degrade rule.
   - Update the module-header persistence comment (per-session fork rule).
2. `src/ui/shell-panel.tsx` — the empty-state text and the module-header
   comment say the graph is per session (forked from the workspace's on
   first edit).
3. `src/client.tsx` — the header comment's persistence paragraph.

**Testing and verification.**

- `pnpm typecheck && pnpm test && pnpm build` — green (the client is not
  unit-tested; the five suites must stay green).
- **Browser verification (required, Chrome DevTools skill attached to the
  EXISTING Chrome window/tab; `pnpm build` then hard refresh):**
  1. Session A: build a two-node graph → `.agent-pipeline/pipelines/<A>.json`
     appears; the legacy `pipeline.json` is untouched.
  2. Session B (same workspace, never edited): its Pipelines tab shows the
     LEGACY graph (read-through); edit it → B's own file appears; switch
     back to A → A's graph, unchanged by B's edit. This is the fork.
  3. Run in A and in B (one-node graphs) → BOTH run concurrently (no 409);
     start a second run in A while A's run is active → 409 names it.
  4. Reload the page while a run is active (or paused at a breakpoint) →
     the view restores THAT session's run, not another session's.
  5. The shell panel on a brand-new session: opens, composes, and saves
     keyed to that session; switching sessions in the panel switches
     pipelines.
  6. Session switch under an active run: switch sessions in the open panel
     while session A's run is active → B's view does not show, follow, or
     control A's run, no result modal pops when A's run settles, and A's
     graph is not written into B's file by a pending save.
  7. Curl spot-check: the legacy cwd-only GET still returns the shared
     graph.

## S4 — Docs and status flip

**Scope.** The written record. Every claim that pipelines and runs are
per workspace becomes the per-session rule, the fork, and the concurrency
caveat.

**Implementation.**

1. `docs/reference/architecture.md` — the route table's persistence row
   (the `sessionId` parameter, the fallback, the fork), the storage
   paragraph, and the project-layout bullets for `index.ts` / `runs.ts` /
   `storage.ts`.
2. `docs/guide/canvas.md` — the persistence section (~line 186): the
   per-session file, the copy-on-write fork from the legacy workspace
   file, orphaned files as a known limit.
3. `docs/guide/running-pipelines.md` — the record location note (~line 57),
   the single-active-run rule (~line 124) restated per session with the
   concurrent-runs-in-one-workspace caveat (agents can collide on repo
   files), and the ~line 207 mention.
4. Sweep for stale phrasing: `grep -rnE "per[ -](workspace|repository)"
   docs/ src/` and reconcile each hit (the proposal's own historical
   sections excepted; expect `src/index.ts:4` among them).
5. Flip this file's **Status** header to **Built**.

**Testing and verification.** `pnpm typecheck && pnpm test && pnpm build`
green; a docs-only pass needs no browser round, but re-run the S3 script's
steps 1-2 once against the final build as the release gate. One commit,
tree clean.

## Non-goals (explicitly out of scope)

- A pipeline manager (multiple NAMED pipelines per session, a picker,
  import/export) — a separate future feature; this plan keys exactly one
  graph per session.
- Orphan cleanup for deleted sessions' `pipelines/<id>.json` files.
- A "reset to the workspace pipeline" action after a fork (hand-edit or a
  future reset action can restore it).
- Any change to the DeepSeek Harness repository (read-only reference) or to
  the run-record schema.
