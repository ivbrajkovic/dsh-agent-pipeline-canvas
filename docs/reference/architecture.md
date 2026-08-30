# Architecture

The plugin is **three faces over one pure core**: a Node-side Host half that
owns storage and execution, a browser half that renders the canvas, and a
pure core of contracts imported by both. This document walks each face and
the full project layout. The behavioral rules themselves live in
[graph-and-execution.md](graph-and-execution.md); day-to-day usage in the
[guides](../index.md).

## The pure core

`src/types.ts` + `src/graph.ts` + `src/execution.ts` + `src/kernel.ts` +
`src/projection.ts` — no Node/browser APIs, no I/O, no React:

- **`src/types.ts`** — the shared contract types: `PipelineGraph` / `Agent` /
  `Connection`, port specs and output bindings, validation errors and
  results, agent execution input, pipeline execution result, runner
  request/result, and the durable run record (the v2 firing log, plus the
  read-only legacy v1 shape) and control shapes.
- **`src/graph.ts`** — canonical graph semantics: pure
  `validateGraph(graph)` / `findCycle`, imported by the Host, the runner,
  **and** the browser bundle (tsdown inlines it, so there is exactly one
  implementation of the graph semantics — never a second hand-written copy in
  the browser).
- **`src/execution.ts`** — the canonical execution contract (pure): the
  port-graph view (`portGraph` — resolved ports and wired edges, shared by
  validation and the kernel), binding evaluation, classification
  (root/terminal/orphan), the per-agent input shape, the default prompt
  framing, and the final-result shape.
- **`src/kernel.ts`** — the firing kernel (pure stream mechanics): per-port
  FIFO queues with policies, bound enforcement (delivery-count drops), the
  halt gate, `maxInFlight` accounting, selective emission, quiescence with
  starving-node candidates, and promise-based readiness. It says WHICH node
  may fire next; the executor owns every side effect.
- **`src/projection.ts`** — the per-node view over a run record (pure
  `projectNodes(record)`): the record is a FIRING LOG, so per-node status,
  latest output, and the child session address are COMPUTED, never stored —
  one implementation shared by the Host-side tests and the browser bundle
  (tsdown inlines it like `graph.ts`). Reads legacy v1 records too.

`src/storage.ts` implements the atomic temp-file+rename write protocol shared
by the pipeline file and the run records.

## The Host half (Node)

`src/index.ts` + `src/runner.ts` + `src/runs.ts`. Mounts as the Cordis plugin
row `agent-pipeline-canvas` and registers exact `webServer` routes:

| Route | Purpose |
|-------|---------|
| `GET\|POST /dsh-agent-pipeline` | Persistence. `GET ?cwd=<absolute project root>` reads `<cwd>/.agent-pipeline/pipeline.json` (or `null` when absent) and also returns `run` — the workspace's active run record (or `null`). `POST { cwd, graph }` writes it atomically. A relative or empty `cwd` is refused, so the file can only land under a real project directory. Both responses carry a `validation` field (the `validateGraph` result for the graph on disk) without changing the load/save behaviour. |
| `POST /dsh-agent-pipeline/run` | Starts a durable run and returns `{ ok, runId }` immediately. One run is active per workspace — a second concurrent start answers `409 { ok: false, activeRunId }`. |
| `GET /dsh-agent-pipeline/run` | One run's full record (`?id=…&cwd=…`; debug/fallback for the SSE stream). |
| `GET /dsh-agent-pipeline/run/events` | The run's SSE stream: `event: snapshot` (full record) on every connect/reconnect, `event: update` per transition. |
| `POST /dsh-agent-pipeline/control` | Resume / rerun / steer / abort a run: `{ runId, cwd, action, feedback? }` → `{ ok }` or a typed error. |
| `GET /dsh-agent-pipeline/options?provider=<id>` | The registered LLM provider routes plus one route's advertised models, read server-side off the `llm` service (per-provider model catalogs are not remotely callable). Degrades to empty lists so the settings fields stay free-form. |

Supporting modules:

- **`src/runner.ts`** — per-agent primitives: `runOneAgent` (one-shot
  `spawn` child with settings forwarding), `startContinuableAgent` /
  `steerContinuableAgent` (the breakpoint path), and the legacy blocking
  `runPipeline` executor.
- **`src/runs.ts`** — the durable run registry: the kernel driver (one
  NodeRunner task per firing), the control plane (pause mailbox,
  pending-pause queue, steer/rerun routing, abort drain), per-node parent
  anchor lifecycle, the commit writer (one chained transition per record
  mutation), the subagent/end settlement matcher, the restart sweep, and the
  single-active-run rule.

## The browser half

`src/client.tsx` is the browser entry: slot registration only — the
components live in `src/ui/`, one module + one stylesheet per surface
(`pipeline-view`, `agent-config`, `run-modal`, `result-modal`,
`inspect-modal`, `shell-panel`, `shared`). Each `.css` import compiles into a
tagged `<style data-plugin-css>` injector at factory materialization (see
`tsdown.config.ts`).

The canvas registers into three additive slots:

- **`conversation.view`** (`id: pipeline`, `order: 30`) — the per-session
  **Pipelines** tab.
- **`conversation.input.left`** (`id: pipeline-trigger`) — a compact
  **Pipelines** icon button in the composer tool row. The tool row renders on
  the blank-session hero too, so this is the trigger that works on a
  brand-new chat.
- **`shell.overlay`** (`id: pipeline-panel`) — the frame-wide panel the
  button opens, bound to the CURRENT session. The overlay also receives the
  root `useWorkspaces` standard hook so the view can resolve the pipeline's
  workspace.

**Bundling and roster pickup:** everything is bundled by tsdown into
`lib/client.js` in the `window.__ModuleLoader__.load(...)` format the browser
module system consumes, and is picked into the browser roster because
`package.json` declares `dsh.client` and `exports["./client"]`. The view
reads the session's workspace root (cwd) from the framework standard kit
(`useSessions`), loads on mount, and saves after every graph change — which
is what survives the view-tab switch that would otherwise drop
component-local React state.

The Host and the browser touch harness services through minimal structural
interfaces rather than the full Cordis types, and the package has **zero
runtime dependencies**.

## Project layout

The source lives under `src/` (TypeScript); the shipped artifacts under
`lib/` are build output (`npm run build` →
`tsc -p tsconfig.build.json && tsdown --config tsdown.config.ts`), matching
the DSH plugin convention. The node half (`lib/index.js`, `lib/graph.js`,
`lib/execution.js`, `lib/kernel.js`, `lib/projection.js`, `lib/runner.js`,
`lib/runs.js`, `lib/storage.js`, `lib/types.js`, … + `.d.ts`) is emitted by
tsc; the browser bundle (`lib/client.js`) is built by tsdown.

```
dsh-agent-pipeline-canvas/
  package.json          dual-face metadata (dsh.client → browser roster), zero
                        runtime deps; typecheck/test/build scripts + devDeps
  tsconfig.json         whole-tree noEmit typecheck facade (incl. the browser client)
  tsconfig.build.json   node-half emit: src/*.ts -> lib/*.js + lib/*.d.ts (excl. client)
  tsdown.config.ts      browser bundle: src/client.tsx -> lib/client.js (module-loader format)
  src/types.ts          shared contract types (PipelineGraph / Agent / Connection,
                        port specs + output bindings, validation errors+results,
                        agent execution input, pipeline execution result, runner
                        request/result, durable run record and control shapes)
  src/graph.ts          canonical graph semantics: pure validateGraph(graph) /
                        findCycle — imported by the Host, the runner, AND the
                        browser bundle (inlined by tsdown)
  src/execution.ts      canonical execution contract (pure): the port-graph view
                        (portGraph), binding evaluation, classification
                        (root/terminal/orphan), the per-agent input shape, the
                        default prompt framing, and the final-result shape
  src/kernel.ts         the firing kernel (pure): port queues + policies, bounds,
                        halt gate, maxInFlight, selective emission, quiescence,
                        promise-based readiness
  src/projection.ts     the per-node projection over a run record (pure
                        projectNodes): status/latest-output/child-session per
                        node, computed from the firing log — shared by the
                        tests and the browser bundle (inlined by tsdown)
  src/storage.ts        the atomic temp-file+rename write protocol shared by the
                        pipeline file and the run records
  src/index.ts          Host half: Cordis plugin row + the webServer routes
                        (persistence with atomic writes, durable run start +
                        record read + SSE stream + control, options catalog)
  src/runner.ts         per-agent primitives: runOneAgent (one-shot `spawn` child
                        with settings forwarding), startContinuableAgent /
                        steerContinuableAgent (breakpoint path), and the legacy
                        blocking runPipeline executor
  src/runs.ts           the durable run registry: kernel driver + one NodeRunner
                        task per firing, the control plane (pause mailbox,
                        pending-pause queue, abort drain), per-node parent anchor
                        lifecycle, the commit writer, the subagent/end settlement
                        matcher, restart sweep, single-active-run rule
  src/client.tsx        browser entry: slot registration only (components in
                        src/ui/ — pipeline-view, agent-config, run-modal,
                        result-modal, inspect-modal, shell-panel, shared; each
                        `.css` import compiles into a tagged
                        <style data-plugin-css> injector)
  src/ui/*.tsx|css      one module + one stylesheet per UI surface
  test/validate.test.ts    validateGraph smoke tests
  test/execution.test.ts   execution-contract smoke tests (ports, bindings, framing)
  test/message.test.ts     run-dialog message composition tests
  test/runner.test.ts      runner-orchestration smoke tests
  test/runs.test.ts        the marble-style verification matrix: fan-in ordering,
                           bounded cycles, starvation, fail-fast, abort drain,
                           double-breakpoint queue, maxInFlight, anchor lifecycle,
                           determinism, restart sweep, 409, degradation
  docs/                 this documentation (start at docs/index.md)
  lib/                  committed build output — rebuild, never hand-edit
```

Each `src/*.ts` module header documents its full contract; the tables above
are the summary.
