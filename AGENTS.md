# AGENTS.md

**dsh-agent-pipeline-canvas** — a DSH Web composition plugin: a visual
agent-pipeline canvas in every session (a *Pipelines* tab). The graph is a DAG
of agents run by delegating each one to the harness's own `subagents` service;
it persists per repository at `<workspace>/.agent-pipeline/pipeline.json`.
`README.md` is the full human-facing doc.

Verified end-to-end in the browser (2026-08-28): `agents.get(sessionId)`
resolves a live parent from route context; a two-agent pipeline ran
sequentially, agent-1's output reached agent-2 under its source label, and the
route returned the contract shape `{ ok, outputs, runs, order }`. The UI round
is verified the same way: the Run modal attaches a workspace file as an
absolute path, the first agent reads it with its own tools, and all three
result-modal continue routes prefill a composer without auto-sending.

## Architecture

Three faces over one pure core:

- **Host half** — `src/index.ts` + `src/runner.ts` (Node). Mounts as plugin row
  `agent-pipeline-canvas`. Registers two exact `webServer` routes:
  - `GET|POST /dsh-agent-pipeline` — load/save `<cwd>/.agent-pipeline/pipeline.json`
    (only under an absolute `cwd`; written atomically).
  - `POST /dsh-agent-pipeline/run` — run a snapshot `{ sessionId, graph, input }`.
- **Browser half** — `src/client.ts` (React via `createElement`, no JSX),
  bundled by tsdown into `lib/client.js` in the `window.__ModuleLoader__.load(...)`
  format. Registers three slots; loads/saves through the Host routes:
  - `conversation.view` (`id: pipeline`, `order: 30`) — the per-session
    *Pipelines* tab (rendered by the harness only for non-blank sessions).
  - `conversation.input.left` (`id: pipeline-trigger`, `order: 40`) — a compact
    **Pipelines** icon button in the composer tool row. The tool row renders in
    the blank-session Hero too, so this is the trigger that works on a
    brand-new chat (the harness hides the title bar and tab ring there).
  - `shell.overlay` (`id: pipeline-panel`) — a frame-wide panel bound to the
    CURRENT session (read off the root `useSessions` hook), opened by the
    composer trigger. It renders in EVERY app state; opening the panel mounts a
    fresh view, closing unmounts it. The overlay entry also receives the root
    `useWorkspaces` standard hook — the view needs it to resolve the
    pipeline's workspace for the continue route.
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
- **Cancellation**: each run POST owns an `AbortController`, aborted when the
  browser connection closes before the response completes (the client Stop
  button, tab close, reload). The signal stops the in-flight agent mid-run via
  the harness driver (stopReason `aborted`) and the runner starts no further
  agent; the result then carries `aborted: true`. Run state is in-memory only —
  a profile restart kills any in-flight run.
- **Deliberately not implemented** (deferred, do not build yet): parallel
  execution, retries, conditions, loops, model/tool selection, live execution
  visualization. The planned upgrade for the blocking synchronous Run POST is a
  background Job (`@deepseek-ai/dsh-jobs`) with a run id + polling.

## Development loop

`node_modules/` symlinks the toolchain out of the harness checkout, so the
`package.json` scripts run with no install step (there is no pnpm here):

```
npm run typecheck
npm test            # 88 tests
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

- **Never modify the harness — STRICTLY PROHIBITED**: the harness checkout at
  `/Users/Ivan.Brajkovic/Desktop/deepseek-harness` is READ-ONLY reference.
  Editing, patching, or configuring around any file in it to make plugin work
  easier is forbidden — if the plugin seems to need a harness change, stop and
  surface the constraint to the user instead. Harness behavior is a design
  given, not a dependency to adjust.
- **No credentials**: never embed or log API keys/credentials; keep
  execution-side credential handling on the Host side.
- **Harness conventions** (read-only, above): the harness checkout is the
  source of truth for DSH plugin conventions — `packages/subagent/` for the
  `subagents`/`spawn`/`fork` seam; `packages/client/tsdown.client.ts` is the
  workspace-coupled preset a standalone plugin must NOT reuse (this package
  has its own `tsdown.config.ts`).
- **Import style**: source imports are spelled with `.ts` extensions
  (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` rewrite them
  to `.js` on emit) — keep new imports in that style.
- **Dynamic client ctx is a guarded allowlist**: every service the client
  touches must be on the module's `inject` (property reads of undeclared
  services REJECT and crash the slot entry), and nested Remote namespaces need
  their own dotted entry (`remote.fileReferences`, the same convention
  ui-reference uses). Accessing a service property can itself throw — guard
  service probing in try/catch.
- **Result-modal state is per-mount**: switching conversation tabs or sessions
  unmounts the view and drops the run result (freshly re-loaded each mount).
  The toolbar Result button only reopens a modal dismissed without leaving.
- **Slot entry hooks must be constant across renders**: a component that adds
  hook calls after a state flip dies with React error #310 ("rendered more
  hooks"). The shell-overlay entry is split into a one-hook gate
  (`PipelinePanelEntry`) plus a body (`PipelinePanel`) that mounts fresh —
  keep that shape when editing it.
- **The `conversation.view` tab ring is harness-gated on blank sessions** — do
  not try to re-enable it from the plugin; the composer tool-row trigger +
  shell overlay panel exist for exactly that state.
- **New chats are born attached to a workspace** (New Session goes through
  `uiWorkspace.connectWorkspace` → `sessions.create({ workspaceId })`), so the
  blank session's cwd is already the workspace path. Never create sessions
  with only a `cwd` — the sidebar tree renders sessions out of
  `workspace.sessionIds`, so a cwd-only session is an invisible orphan.
