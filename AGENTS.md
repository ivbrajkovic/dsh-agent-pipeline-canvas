# AGENTS.md

**dsh-agent-pipeline-canvas** — a DSH Web composition plugin: a visual
agent-pipeline canvas in every session (a *Pipelines* tab). The graph is a DAG
of agents run by delegating each one to the harness's own `subagents` service;
it persists per repository at `<workspace>/.agent-pipeline/pipeline.json`.
`README.md` is the full human-facing doc.

Open verification: a real end-to-end run in the browser (confirming
`agents.get(sessionId)` resolves a live parent from route context).

## Architecture

Three faces over one pure core:

- **Host half** — `src/index.ts` + `src/runner.ts` (Node). Mounts as plugin row
  `agent-pipeline-canvas`. Registers two exact `webServer` routes:
  - `GET|POST /dsh-agent-pipeline` — load/save `<cwd>/.agent-pipeline/pipeline.json`
    (only under an absolute `cwd`; written atomically).
  - `POST /dsh-agent-pipeline/run` — run a snapshot `{ sessionId, graph, input }`.
- **Browser half** — `src/client.ts` (React via `createElement`, no JSX),
  bundled by tsdown into `lib/client.js` in the `window.__ModuleLoader__.load(...)`
  format. Injects the Pipelines view into the `conversation.view` slot
  (`id: pipeline`, `order: 30`); loads/saves through the Host routes.
- **Pure core** — `src/types.ts` / `src/graph.ts` / `src/execution.ts`, imported
  by both halves. tsdown **inlines** `validateGraph` into the client bundle, so
  there is exactly ONE implementation of the graph semantics — never re-add a
  client-side copy.

Host and browser touch harness services through **minimal structural
interfaces** (defined next to their use in `src/`) — not the full Cordis types.
The plugin has **zero runtime dependencies**.

## Contracts

Read the `src/*.ts` module headers before touching that module's semantics —
they are the full authoritative rules. The cross-cutting invariants:

- **Detection, not enforcement**: `validateGraph` reports issues; persistence
  writes regardless, and the runner re-validates before running.
- Every agent receives exactly ONE input object keyed by source; roots get
  `{ "$input": pipelineInput }`. `"$input"` is the only reserved name.
- The result is always `{ outputs: { [terminalId]: output } }`.
- The runner resolves the session's live parent Agent, then runs agents
  **sequentially** in `topoOrder`; a node runs only when EVERY upstream has run
  (the fan-in *wait-for-all-upstreams* rule). A non-`completed` stopReason is
  recorded on the run, not treated as pipeline failure.
- **Deliberately not implemented** (deferred, do not build yet): parallel
  execution, retries, conditions, loops, cancellation, model/tool selection,
  live execution visualization. The planned upgrade for the blocking
  synchronous Run POST is a background Job (`@deepseek-ai/dsh-jobs`) with a
  run id + polling.

## Development loop

`node_modules/` symlinks the toolchain out of the harness checkout, so the
`package.json` scripts run with no install step (there is no pnpm here):

```
npm run typecheck
npm test            # 70 tests
npm run build
```

Change discipline, in order: edit `src/` → build → re-run the tests → sync to
the profile copy (below). `lib/` is committed build output — rebuild it, never
hand-edit; a rebuild shows up in `git status`, and semantics changes must move
the tests with them. **Done** = all three test files green AND the synced
profile answers the same on the wire.

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

## Gotchas

- **No credentials**: never embed or log API keys/credentials; keep
  execution-side credential handling on the Host side.
- **Harness conventions**: the harness checkout at
  `/Users/Ivan.Brajkovic/Desktop/deepseek-harness` is the source of truth for
  DSH plugin conventions — `packages/subagent/` for the `subagents`/`spawn`/`fork`
  seam; `packages/client/tsdown.client.ts` is the workspace-coupled preset a
  standalone plugin must NOT reuse (this package has its own `tsdown.config.ts`).
- **Import style**: source imports are spelled with `.ts` extensions
  (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` rewrite them
  to `.js` on emit) — keep new imports in that style.
