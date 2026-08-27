# AGENTS.md

**dsh-agent-pipeline-canvas** — a DSH Web composition plugin that puts a visual
**agent-pipeline** canvas in every session as a *Pipelines* tab. Drag agents from
a palette, connect output ports to input ports, edit each agent's
name/description/instructions, and run the resulting DAG: the runner delegates
each agent to the harness's own `subagents` service (`spawn`) in deterministic
topological order, passes outputs downstream, and returns
`{ outputs: { [terminalId]: output } }`. The graph persists per repository at
`<workspace>/.agent-pipeline/pipeline.json`.

**Current state (verified this session):** TypeScript migration complete;
typecheck clean; **70/70** tests pass; build (tsc + tsdown) green; the profile
copy is byte-identical to this tree; both Host routes (`/dsh-agent-pipeline` and
`/dsh-agent-pipeline/run`) are **live** in the running web profile. The one open
verification: a real end-to-end run in the browser (confirming
`agents.get(sessionId)` resolves a live parent from route context).

## Layout

```
src/types.ts      shared contract types (imported type-only by the browser)
src/graph.ts      canonical DAG validation (validateGraph / findCycle) — PURE
src/execution.ts  canonical execution contract (classifyGraph / topoOrder /
                  agentInput / agentPrompt / pipelineResult) — PURE
src/runner.ts     minimal sequential runner (Host side, structural service types)
src/index.ts      Host half: Cordis plugin row + the two webServer routes
src/client.ts     browser half: the Pipelines view tab (bundled by tsdown)
test/*.test.ts    plain-Node smoke tests (tsx), 70 total
lib/              committed build output — NEVER hand-edit; rebuild instead
README.md         full doc; a few sections are stale (see Gotchas)
```

## Architecture

Three faces over one pure core:

- **Host half** — `src/index.ts` + `src/runner.ts` (Node). Mounts as plugin row
  `agent-pipeline-canvas`. Registers two exact `webServer` routes:
  - `GET|POST /dsh-agent-pipeline` — load/save `<cwd>/.agent-pipeline/pipeline.json`
    (refuses relative/empty `cwd`; atomic temp-file+rename writes; responses
    carry an additive `validation` field).
  - `POST /dsh-agent-pipeline/run` — run a snapshot `{ sessionId, graph, input }`.
- **Browser half** — `src/client.ts` (React via `createElement`, no JSX). Bundled
  by tsdown into `lib/client.js` in the `window.__ModuleLoader__.load(...)`
  format; only `react` is external. Injects the Pipelines view into the
  `conversation.view` slot (`id: pipeline`, `order: 30`). Loads/saves through the
  Host routes, debounced (250 ms).
- **Pure core** — `src/types.ts` / `src/graph.ts` / `src/execution.ts`, imported
  by both halves. tsdown **inlines** `validateGraph` into the client bundle, so
  there is exactly ONE implementation of the graph semantics — never re-add a
  client-side copy.

Host and browser touch harness services through **minimal structural
interfaces** (defined in `src/runner.ts`, `src/index.ts`, `src/client.ts`) — not
the full Cordis types. The plugin has **zero runtime dependencies**.

## Development loop

The plugin's `node_modules/` symlinks the toolchain into the harness checkout
(`pnpm` is not installed here) — run the binaries directly from this directory:

```
./node_modules/.bin/tsc  -p tsconfig.json                 # typecheck (whole tree)
./node_modules/.bin/tsx  test/validate.test.ts && \
./node_modules/.bin/tsx  test/execution.test.ts && \
./node_modules/.bin/tsx  test/runner.test.ts              # 70 tests
./node_modules/.bin/tsc  -p tsconfig.build.json && \
./node_modules/.bin/tsdown --config tsdown.config.ts      # build: lib/*.js + lib/client.js
```

(Equivalently `pnpm run typecheck|test|build` where a pnpm toolchain exists.)

Change discipline, in order: edit `src/` → build → re-run all three tests →
sync to the profile copy (below). `lib/` is committed output, so a rebuild shows
up in `git status`; semantics changes must move the tests with them. **Done** =
all three test files green AND the synced profile answers the same on the wire.

## Deployment (the profile)

The plugin is deployed as a **copy — not a symlink** at
`~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/` (wired as a
`file:` dep in `~/.dsh/profiles/web/package.json`; row `agent-pipeline-canvas`
in `cordis.patch.yml`). Rebuilds in this tree do NOT reach it:

- **Client change** → sync `lib/client.js` (+ anything else you changed), then
  hard-refresh the browser tab (client is served fresh, no cache).
- **Host change** → sync the affected files, then the web profile must be
  **restarted** for the routes to re-mount.

Sync command (established convention):

```
rsync -a --delete --exclude .git --exclude node_modules ./ ~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/
```

**Never restart the web profile or start a replacement server yourself** — it
hosts the session's agent runtime. Restart is the user's job.

- `pnpm install` inside the profile is currently blocked by a pre-existing,
  unrelated supply-chain policy error (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
  for `dshmarket@1.34.0`); the rsync path does not need it.
- Verify the running profile with
  `curl -s http://127.0.0.1:3080/dsh-agent-pipeline/run` — a
  `{"ok":false,"error":"method not allowed"}` 405 means the route is mounted.

## Contracts

The `src/*.ts` module headers are the full authoritative rules; the essentials:

- **Graph / DAG semantics** (`src/graph.ts`): each agent has exactly one input
  and one output port (`<id>:in` / `<id>:out`). Fan-out and fan-in are allowed.
  A cycle, self-edge, duplicate edge, or dangling agent/port is an error.
  `validateGraph(graph)` → `{ ok, errors: [{ code, message }] }`; an absent graph
  is valid. Validation is **detection, not enforcement** — persistence writes
  regardless, and the runner re-validates before running.
- **Execution contract** (`src/execution.ts`): every agent receives exactly ONE
  input object keyed by source. Roots (in-degree 0, incl. orphans) get
  `{ "$input": pipelineInput }`; every other agent gets `{ [upstreamId]: output }`
  in sorted order. The result is always `{ outputs: { [terminalId]: output } }`.
  Orphans run as root+terminal singletons. `INPUT_KEY = "$input"` is the only
  reserved name (ids are canvas-generated `agent-N`, not user-editable).
- **Runner** (`src/runner.ts`): `runPipeline(ctx, { graph, input, sessionId })`
  validates → resolves the session's **live parent Agent** (`agents.get(sessionId)`;
  the harness `SubagentStartRequest.parent` is required and non-optional) →
  ensures the `spawn` provider is registered → runs agents **sequentially** in
  `topoOrder` (Kahn's algorithm: a node becomes ready only when EVERY upstream
  has run — the fan-in *wait-for-all-upstreams* rule) → passes outputs downstream
  → returns `{ ok, outputs, runs, order }`. A non-`completed` stopReason is
  recorded on the run, not treated as a pipeline failure (no retries). Children
  inherit the parent's provider/model.

**Deliberately not implemented** (deferred, do not build yet): parallel
execution, retries, conditions, loops, cancellation, model/tool selection, live
execution visualization. The Run is currently a blocking synchronous POST; a
background Job (`@deepseek-ai/dsh-jobs`) with a run id + polling is the planned
upgrade.

## Gotchas

- **README.md is partly stale**: it still says the runner is "not implemented
  yet", the client bundle is "hand-written", and tests run as `node test/*.mjs`.
  Trust `src/` and this file when README disagrees.
- **Pending relocation**: the user is considering moving the project to
  `~/personal/`. **Do not move it.** A move is a multi-surface migration with no
  rollback safety net — the workspace root is not under VCS, and DSH session
  history is keyed by the absolute workspace path (moving the folder orphans the
  sessions). Re-verify paths before resuming work if a move happens.
- **No credentials**: never embed or log API keys/credentials; keep
  execution-side credential handling on the Host side.
- **Git state**: this package's repo (`origin` →
  `github.com/ivbrajkovic/dsh-agent-pipeline-canvas`) has ONE commit — the
  JS-era snapshot; the TypeScript migration is uncommitted working-tree state.
  The workspace root is not a git repo at all.
- **Harness conventions**: the harness checkout at
  `/Users/Ivan.Brajkovic/Desktop/deepseek-harness` is the source of truth for
  DSH plugin conventions — `packages/subagent/` for the `subagents`/`spawn`/`fork`
  seam; `packages/client/tsdown.client.ts` is the workspace-coupled preset a
  standalone plugin must NOT reuse (this package has its own `tsdown.config.ts`).
- **Import style**: source imports are spelled with `.ts` extensions
  (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` rewrite them
  to `.js` on emit) — keep new imports in that style.
