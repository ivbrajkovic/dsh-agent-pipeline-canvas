# dsh-agent-pipeline-canvas

Local DSH Web composition plugin: a visual **agent-pipeline** canvas, available
in every session as a **Pipelines** view tab (beside Chat / Trajectory /
Context). Build a DAG of generic agents, then run it — each agent is delegated
to the harness's own `subagents` service as a fresh one-shot child in
deterministic topological order, outputs flow downstream, and the run returns
`{ outputs: { [terminalId]: output } }`. The graph persists per repository.

## The canvas

- Drag an **Agent** from the palette onto the canvas to add a node
  (`Agent 1`, `Agent 2`, …); reposition nodes freely; click to select.
- Drag from an agent's **output** port to another agent's **input** port to
  connect them. Edges are directed and arrow-marked; an output may **fan out**
  to many inputs, and an input may **fan in** from many sources.
- **Double-click an agent** to open its configuration panel and edit its
  `name`, `description`, and `instructions` (single-click still selects).
- The graph is **validated as a DAG** as you edit — a *Valid* / *N issues* chip
  in the toolbar plus an issue strip report cycles, self-connections, duplicate
  edges, and connections referencing a missing agent or port.
- **Run** executes the current snapshot (see [Running a pipeline](#running-a-pipeline));
  **View JSON** exposes the graph as structured data.

## Persistence

The graph is persisted **per repository** at
`<workspace>/.agent-pipeline/pipeline.json`. When the view opens it loads the
file from the session's workspace root, and every change (add / connect / move /
delete / clear / edit an agent's configuration) writes it back (debounced), so
the pipeline survives tab switches and reopens — including each agent's
configuration. The browser loads/saves through a same-origin Host route; the
Host resolves the file under the project root and writes it atomically (temp
file + rename). Because the storage path is the session's workspace directory,
different repositories get independent pipelines.

## How it works

Three faces over one pure core:

- **Host half** — `src/index.ts` + `src/runner.ts` (Node). Mounts as the Cordis
  plugin row `agent-pipeline-canvas` and registers two exact `webServer` routes:
  - `GET|POST /dsh-agent-pipeline` — persistence. `GET ?cwd=<absolute project
    root>` reads `<cwd>/.agent-pipeline/pipeline.json` (or `null` when absent);
    `POST { cwd, graph }` writes it atomically. A relative or empty `cwd` is
    refused, so the file can only land under a real project directory. Both
    responses carry a `validation` field (the `validateGraph` result for the
    graph on disk) without changing the load/save behaviour.
  - `POST /dsh-agent-pipeline/run` — executes a pipeline snapshot (see
    [Running a pipeline](#running-a-pipeline)).
- **Browser half** — `src/client.ts`: the Pipelines view tab, a React component
  registered into the additive `conversation.view` slot (`id: pipeline`,
  `order: 30`), so it appears as a tab in every session. It is bundled by
  tsdown into `lib/client.js` in the `window.__ModuleLoader__.load(...)` format
  the browser module system consumes, and is picked into the browser roster
  because `package.json` declares `dsh.client` and `exports["./client"]`. The
  view reads the session's workspace root (cwd) from the framework standard kit
  (`useSessions`), loads on mount, and saves after every graph change — which is
  what survives the view-tab switch that would otherwise drop component-local
  React state.
- **Pure core** — `src/types.ts` (shared contract types), `src/graph.ts` (DAG
  validation), `src/execution.ts` (execution contract): no Node/browser APIs, no
  I/O, no React, imported by both halves. tsdown **inlines** `validateGraph`
  into the client bundle, so there is exactly one implementation of the graph
  semantics — never a second hand-written copy in the browser.

The Host and the browser touch harness services through minimal structural
interfaces rather than the full Cordis types, and the package has **zero
runtime dependencies**.

## Layout

The source lives under `src/` (TypeScript); the shipped artifacts under `lib/`
are build output (`npm run build` → `tsc -p tsconfig.build.json && tsdown
--config tsdown.config.ts`), matching the DSH plugin convention. The node half
(`lib/index.js`, `lib/graph.js`, `lib/execution.js`, `lib/runner.js`,
`lib/types.js` + `.d.ts`) is emitted by tsc; the browser bundle
(`lib/client.js`) is built by tsdown.

```
dsh-agent-pipeline-canvas/
  package.json          dual-face metadata (dsh.client → browser roster), zero
                        runtime deps; typecheck/test/build scripts + devDeps
  tsconfig.json         whole-tree noEmit typecheck facade (incl. the browser client)
  tsconfig.build.json   node-half emit: src/*.ts -> lib/*.js + lib/*.d.ts (excl. client)
  tsdown.config.ts      browser bundle: src/client.ts -> lib/client.js (module-loader format)
  src/types.ts          shared contract types (PipelineGraph / Agent / Connection,
                        validation errors+results, agent execution input, pipeline
                        execution result, runner request/result)
  src/graph.ts          canonical graph semantics: pure validateGraph(graph) /
                        findCycle — imported by the Host, the runner, AND the
                        browser bundle (inlined by tsdown)
  src/execution.ts      canonical execution contract (pure): classification
                        (root/terminal/orphan), the per-agent input shape, the
                        default prompt framing, the deterministic run order
                        (topoOrder), and the final-result shape
  src/index.ts          Host half: Cordis plugin row + the two webServer routes
                        (persistence with atomic writes, run endpoint)
  src/runner.ts         Host-side minimal sequential runner: validates the snapshot,
                        resolves the session's live Agent as parent, and runs each
                        pipeline agent as a fresh `spawn` subagent in topological order
  src/client.ts         browser half: the Pipelines view tab (canvas, config panel,
                        load/save, live DAG validation UI)
  test/validate.test.ts   validateGraph smoke tests
  test/execution.test.ts  execution-contract smoke tests
  test/runner.test.ts     runner-orchestration smoke tests
  lib/                  committed build output — rebuild, never hand-edit
```

Each `src/*.ts` module header documents its full contract; the sections below
are the summary.

## Graph semantics & validation

The pipeline is a directed acyclic graph (DAG) over the two arrays `agents` and
`connections`:

```json
{
  "agents":      [ { "id", "name", "description", "instructions",
                     "x", "y", "input": "<id>:in", "output": "<id>:out" } ],
  "connections": [ { "id", "source", "target",
                     "sourcePort": "<source>:out", "targetPort": "<target>:in" } ]
}
```

- `A → B` means A's output becomes input to B (an edge from A's output port to
  B's input port).
- Each agent has **exactly one** input port and one output port, named by the
  `<id>:in` / `<id>:out` convention (declared on the agent as `input`/`output`).
- **Fan-out** is allowed (a source id may appear in many connections); **fan-in**
  is allowed (a target id may appear in many connections).
- A node with no incoming edges is a **start** node; a node with no outgoing
  edges is a **terminal** node. A node runs only after every incoming
  dependency has produced its output. No explicit parallel/join nodes.
- A cycle, self-connection, duplicate edge, or a reference to a missing
  agent/port is an error.

`validateGraph(graph)` (in `src/graph.ts`) returns `{ ok, errors }` (each error
is `{ code, message }`) and checks at least: **cycles** (`cycle`), **self**
connections (`connection-self`), **duplicate** edges
(`connection-duplicate`), **missing/unknown** source or target agents and
**missing** ports, and **invalid source/target ports**
(`connection-source-port-mismatch` / `connection-target-port-mismatch`, plus
missing-port variants). Duplicate agent ids and non-array `agents`/
`connections` are also caught. An absent/empty graph is valid (nothing to run).

Validation is **detection, not enforcement**: persistence writes regardless, and
the runner re-validates before running.

## Execution contract

The runtime semantics the runner relies on are defined once, in the pure
`src/execution.ts`, so they are stable and testable (`npm test`). The contract
uses **conventions over new node types / new configuration** and requires **no
persisted schema change** — every rule is derived from the existing
`agents`/`connections` arrays plus **one runtime parameter**, a pipeline-level
`pipelineInput`.

- **Every agent receives exactly ONE structured input — always an object keyed
  by source.** One keying rule ("the source of the value") covers both a
  single-upstream agent and a fan-in agent (1 key vs N keys), so the runner
  never branches on "how many upstreams".
- **Root agent** (in-degree 0, includes orphans): receives the pipeline-level
  input under the reserved key `"$input"` → `{ "$input": <pipelineInput> }`.
  Every root gets the same pipeline input.
- **Single-upstream / fan-out / fan-in agent** (in-degree ≥ 1): receives
  `{ [upstreamId]: <output> }` — one key per upstream agent, in deterministic
  (sorted-by-id) order.
- **Terminal agent** (out-degree 0): its output is part of the final result.
- **Orphan agent** (in-degree 0 **and** out-degree 0): runs as a root + terminal
  singleton — it receives the pipeline input and its output is collected.
- **Final result**: always `{ outputs: { [terminalId]: <output> } }` — keyed by
  terminal id (not a dedicated output node), `{}` when there are no terminals,
  and only for terminals that produced an output.
- **Prompt framing** (the delivery form): because the harness runs an agent with
  a single text prompt, `agentPrompt()` defines a deterministic default —
  `instructions` first, then one `## <source label>` section per input key
  (labels a source by its agent `name`, falling back to the id; the reserved
  `"$input"` key is labelled `Input`). This is a documented convention the
  runner may override per node; the input/result shapes above are the stable
  contract.

The per-agent `instructions`/`name`/`description` fields are reused
(instructions as the prompt seed; name/description to label a source and a
terminal). The only reserved name is `"$input"`, which cannot collide with a
canvas-generated agent id (`agent-N`; ids are not user-editable in the UI).

## Running a pipeline

The browser's *Run* button POSTs `{ sessionId, graph, input }` to
`POST /dsh-agent-pipeline/run` (the graph is the snapshot the user currently
sees). The runner (`src/runner.ts`) then:

1. **Validates** the snapshot with `validateGraph` (rejects an invalid graph).
2. **Resolves the live parent Agent** from `agents.get(sessionId)` — the
   harness subagent contract requires a non-optional `parent: Agent`, so the
   runner must run inside the context of the session's live agent. This is an
   invocation precondition, not an execution-contract change.
3. **Runs each agent** as a fresh one-shot `subagents.start("spawn", ...)` child.
   The prompt is built with the execution contract (`agentPrompt`). A node only
   becomes ready once every upstream has completed (Kahn's algorithm,
   `topoOrder`), which gives the fan-in *wait-for-all-upstreams* rule. Runs
   execute **sequentially**.
4. **Passes each output** to its downstream agents' inputs.
5. **Returns** `{ ok, outputs: { [terminalId]: output }, runs, order }`, where
   `outputs` is the contract's final-result shape and `runs` carries per-agent
   `{ id, label, status }` for a minimal status surface.

The parent's provider/model is inherited by each child (via the harness's
`resolveChildAgentOptions`), so pipeline agents run on the deployment's
configured model. The `spawn` provider is the one registered by the base bundle.
Parallel execution, retries, conditions, loops, cancellation, model/tool
selection, and live visualization are deliberately **not** implemented; the run
is currently a blocking synchronous POST.

## Install & deploy

The plugin is deployed into the local DSH web profile as a **copy** (not a
symlink) at `~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/`.

One-time wiring:

1. Add the dependency to `~/.dsh/profiles/web/package.json`:

   ```json
   "dsh-agent-pipeline-canvas": "file:../../../Desktop/agent-pipeline/dsh-agent-pipeline-canvas"
   ```

2. Add the plugin row to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   # Local composition plugin: agent-pipeline canvas as a Pipelines view tab.
   - id: agent-pipeline-canvas
     name: dsh-agent-pipeline-canvas
   ```

Then, after every build (or any change), sync the tree into the profile and let
the user restart the web profile so the Host routes re-mount:

```
rsync -a --delete --exclude .git --exclude node_modules ./ \
  ~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/
```

Client-only changes need just the sync plus a hard browser refresh (the client
is served fresh, no cache). `pnpm install` inside the profile is currently
blocked by a pre-existing supply-chain policy error
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for `dshmarket@1.34.0`); the rsync
path needs no install. After a restart, verify the route is mounted:

```
curl -s http://127.0.0.1:3080/dsh-agent-pipeline/run
# {"ok":false,"error":"method not allowed"}  (405 on GET = mounted)
```

## Development

`node_modules/` symlinks the toolchain out of the harness checkout, so the
scripts run with no install step:

```
npm run typecheck   # tsc -p tsconfig.json (whole tree, noEmit)
npm test            # all 70 tests: validate + execution + runner
npm run build       # tsc -p tsconfig.build.json && tsdown → lib/
```

Change discipline, in order: edit `src/` → build → re-run the tests → sync to
the profile (above). `lib/` is committed output, so a rebuild shows up in
`git status`; semantics changes must move the tests with them. Source imports
are spelled with `.ts` extensions (`allowImportingTsExtensions` rewrites them to
`.js` on emit) — keep new imports in that style.
