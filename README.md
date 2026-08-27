# dsh-agent-pipeline-canvas

Local DSH Web composition plugin: a visual **agent-pipeline** canvas, available in
every session as a **Pipelines** view tab (beside Chat / Trajectory / Context).

Drag a generic **Agent** from the palette onto the canvas to add a node
(`Agent 1`, `Agent 2`, …), reposition nodes freely, click to select, and drag
from an **output** port to another agent's **input** port to connect them.
Connections are drawn as directed, arrow-marked edges; an output fans out to
many inputs. **Double-click an agent** to open its configuration panel, where
you can edit its `name`, `description`, and `instructions` (single-click still
selects; dragging, connecting, and fan-out are unaffected). The graph is kept as
structured data (agents with `id/name/description/instructions/x/y/input/output`
plus `connections` with `source/target/ports`), and a **View JSON** toggle
exposes it. The graph is **validated as a DAG** as you edit — a small *Valid* /
*N issues* chip in the toolbar and a non-intrusive issue strip below it report
cycles, self-connections, duplicate edges, and any connection that references a
missing agent or port. A **minimal sequential runner** is implemented: a *Run*
button in the toolbar executes the snapshot, sending each agent to the harness's
own `subagents` service as a fresh one-shot child in deterministic topological
order, passing each output downstream and returning the contract's
`{ outputs: { [terminalId]: output } }` result. Parallel execution, retries,
conditions, loops, cancellation, model/tool selection, and live visualization are
still **not** implemented.

The graph is **persisted per repository**: when the view opens it loads
`.agent-pipeline/pipeline.json` from the session's workspace root, and every
change (add / connect / move / delete / clear / edit an agent's configuration)
writes it back. Leaving the Pipelines tab or reopening the project restores the
same graph, including each agent's `name`/`description`/`instructions`. The
browser loads/saves through a same-origin Host route (`/dsh-agent-pipeline`);
the Host half resolves the file under the project root and writes it atomically.
Because the storage path is the session's workspace directory, different
repositories get independent pipelines. See `src/index.ts` (Host route) and
`src/client.ts` (load/save in the view).

## Layout

The plugin is TypeScript: the source lives under `src/` and the shipped
artifacts under `lib/` are produced by the standard build
(`pnpm run build` → `tsc -p tsconfig.build.json && tsdown --config tsdown.config.ts`),
matching the DSH plugin convention (as the published `dsh-better-sidebar` does).
`src/client.ts` is bundled into `lib/client.js` by tsdown in the
`window.__ModuleLoader__.load({ id, factory })` format the browser module system
consumes; the node half (`lib/index.js`, `lib/graph.js`, `lib/execution.js`,
`lib/runner.js`, `lib/types.js` + `.d.ts`) is emitted by tsc.

```
dsh-agent-pipeline-canvas/
  package.json          dual-face metadata (dsh.client → browser roster), zero
                        runtime deps; build/test scripts + devDeps
  tsconfig.build.json   node-half emit: src/*.ts -> lib/*.js + lib/*.d.ts (excl. client)
  tsconfig.json         whole-tree noEmit typecheck facade (incl. the browser client)
  tsdown.config.ts      browser bundle: src/client.ts -> lib/client.js (module-loader format)
  src/index.ts          Host half: Cordis plugin row — registers the `/dsh-agent-pipeline`
                        route (load/save + atomically write pipeline.json) and returns the
                        graph's DAG `validation` on GET/POST.
  src/client.ts         Browser half: the Pipelines view tab in conversation.view
                        (canvas, config panel, load/save, and live DAG validation UI).
                        Bundled by tsdown; it imports the shared validateGraph.
  src/graph.ts          Canonical graph-semantics module: pure `validateGraph(graph)` /
                        `findCycle`. Imported by the Host, the runner, AND the browser
                        bundle (inlined by tsdown) — one implementation, no duplication.
  src/execution.ts      Canonical execution-contract module (pure): classification
                        (root/terminal/orphan), the per-agent input shape, the default
                        prompt framing, the deterministic run order (`topoOrder`), and
                        the final-result shape.
  src/runner.ts         Host-side minimal sequential runner: validates the snapshot,
                        resolves the session's live Agent as parent, and runs each
                        pipeline agent as a fresh `spawn` subagent in topological order.
  src/types.ts          Shared contract types (PipelineGraph / Agent / Connection, validation
                        errors+results, agent execution input, pipeline execution result,
                        runner request/result) — imported by both halves.
  test/validate.test.ts   Smoke test for validateGraph (tsx test/validate.test.ts).
  test/execution.test.ts  Smoke test for the execution contract (tsx test/execution.test.ts).
  test/runner.test.ts     Smoke test for the runner orchestration (tsx test/runner.test.ts).
  lib/                  Build output (committed, like dsh-better-sidebar).
```

## Graph semantics & validation

The pipeline is treated as a directed acyclic graph (DAG) over the two arrays
[`agents` and `connections`](#how-it-works). The contract that execution will
depend on is defined once, in `lib/graph.js`:

- `A → B` means A's output becomes input to B (an edge from A's output port to
  B's input port).
- Each agent has **exactly one** input port and one output port, named by the
  `<id>:in` / `<id>:out` convention (declared on the agent as `input`/`output`).
- **Fan-out** is allowed: an output may feed many targets (a source id appears
  in many connections).
- **Fan-in** is allowed: an input may receive from many sources (a target id
  appears in many connections, all targeting the same input port).
- A node with no incoming edges is a **start** node; a node with no outgoing
  edges is a **terminal** node. A node runs only after every incoming dependency
  has produced its output. No explicit parallel/join nodes.
- The graph must not contain a cycle, self-connection, duplicate edge, or a
  reference to a missing agent/port.

`validateGraph(graph)` returns `{ ok, errors }` (each error is
`{ code, message }`) and checks at least: **cycles** (`cycle`), **self**
connections (`connection-self`), **duplicate** edges (`connection-duplicate`),
**missing / unknown** source or target agents and **missing** source/target,
and **invalid source / target ports** (`connection-source-port-mismatch` /
`connection-target-port-mismatch`, plus missing-port variants). Duplicate agent
ids and non-array `agents`/`connections` are also caught. An absent/empty graph
is valid (nothing to run).

`validateGraph` is shared between the Host and the browser: the browser bundle
is built by tsdown from `src/client.ts`, which imports `validateGraph` from
`src/graph.ts`, so tsdown inlines a single implementation rather than a second
hand-written copy. The Host returns its own authoritative `validation` alongside
`pipeline` on GET and on the POST acknowledgement, so any consumer (e.g. a
future runner) gets the on-disk graph checked without changing the write
behaviour.

## Execution contract

The runner is not implemented yet, but the runtime semantics it will rely on are
now defined once, in the pure `lib/execution.js`, so they are stable and testable
(`node test/execution.test.mjs`). The contract uses **conventions over new node
types / new configuration** and requires **no persisted schema change** — every
rule below is derived from the existing `agents`/`connections` arrays plus **one
runtime parameter**, a pipeline-level `pipelineInput`.

The graph is the same `{ agents, connections }` DAG as above. The contract adds
runtime semantics only:

- **Every agent receives exactly ONE structured input — always an object keyed by
  source.** One keying rule ("the source of the value") covers both a
  single-upstream agent and a fan-in agent (1 key vs N keys), so the runner never
  branches on "how many upstreams". This is answered affirmatively for the fan-in
  question: keying by upstream agent id —
  `{ "agent-2": "...", "agent-3": "..." }` — is a good default, and we make it the
  *uniform* shape for every non-root agent rather than a fan-in-only special case.

- **Root agent** (in-degree 0, includes orphans): receives the pipeline-level
  input under the reserved key `"$input"` → `{ "$input": <pipelineInput> }`. Every
  root gets the same pipeline input.

- **Single-upstream / fan-out / fan-in agent** (in-degree ≥ 1): receives
  `{ [upstreamId]: <output> }` — one key per upstream agent, in deterministic
  (sorted-by-id) order.

- **Terminal agent** (out-degree 0): its output is part of the final result.

- **Orphan agent** (in-degree 0 **and** out-degree 0): runs as a root + terminal
  singleton — it receives the pipeline input and its output is collected. This is
  the least-surprising DAG interpretation and needs no special rule; a runner may
  surface it as an "isolated agent" warning, but the contract does not skip it.

- **Final result**: always `{ outputs: { [terminalId]: <output> } }` — keyed by
  terminal id (not a dedicated output node), `{}` when there are no terminals, and
  only for terminals that produced an output.

- **Prompt framing** (the delivery form): because the harness runs an agent with a
  single text prompt, `agentPrompt()` defines a deterministic default —
  `instructions` first, then one `## <source label>` section per input key (labels
  a source by its agent `name`, falling back to the id; the reserved `"$input"`
  key is labelled `Input`). This is a documented convention the runner may override
  per node; the input/result shapes above are the stable contract.

The per-agent `instructions`/`name`/`description` fields are reused (instructions
as the prompt seed; name/description to label a source and a terminal). The only
reserved name is `"$input"`, which cannot collide with a canvas-generated agent id
(`agent-N`; ids are not user-editable in the UI). Scheduling, retries, conditions,
loops, model selection, tool configuration, and credentials are **out of scope** —
that is the runner's job.

## Running a pipeline (minimal sequential runner)

The Host registers `POST /dsh-agent-pipeline/run`. The browser's *Run* button
POSTs `{ sessionId, graph, input }` (the graph is the snapshot the user currently
sees). `lib/runner.js` then:

1. **Validates** the snapshot with `validateGraph` (rejects an invalid graph).
2. **Resolves the live parent Agent** from `agents.get(sessionId)` — the harness
   subagent contract requires a non-optional `parent: Agent`, so the runner must
   run inside the context of the session's live agent. This is an invocation
   precondition, not an execution-contract change.
3. **Runs each agent** as a fresh one-shot `subagents.start("spawn", ...)` child.
   The prompt is built with the execution contract (`agentPrompt`). A node only
   becomes ready once every upstream has completed (Kahn's algorithm, `topoOrder`),
   which gives the fan-in *wait-for-all-upstreams* rule. Runs execute
   **sequentially**.
4. **Passes each output** to its downstream agents' inputs.
5. **Returns** `{ ok, outputs: { [terminalId]: output }, runs, order }`, where
   `outputs` is the contract's final-result shape. `runs` carries per-agent
   `{ id, label, status }` for a minimal status surface.

The parent's provider/model is inherited by each child (via the harness's
`resolveChildAgentOptions`), so pipeline agents run on the deployment's configured
model. The `spawn` provider is the one registered by the base bundle. Parallel
execution, retries, conditions, loops, cancellation, and model/tool selection are
deliberately not implemented.

## How it works

- The Host half (`lib/index.js`) registers two exact routes on `webServer`:
  `POST /dsh-agent-pipeline/run` executes a pipeline snapshot (see [Running a
  pipeline above](#running-a-pipeline-minimal-sequential-runner)), and
  `/dsh-agent-pipeline` handles persistence: `GET ?cwd=…` reads
  `.<cwd>/.agent-pipeline/pipeline.json` (or `null` when absent) and
  `POST { cwd, graph }` writes it atomically. It refuses a non-absolute / empty
  `cwd` so the file can only land under a real project directory. Both persistence
  responses carry a `validation` field (the result of `validateGraph` on the
  graph), added without changing the write or load behaviour.
- The Browser half (`lib/client.js`) is a hand-written bundle in the shipped
  `window.__ModuleLoader__.load(...)` format. It is picked into the browser
  roster by `dsh-client-modules` because `package.json` declares `dsh.client`
  and `exports["./client"]`. It registers the `PipelineView` React component into
  the additive `conversation.view` slot (`id: pipeline`, `order: 30`,
  `label: Pipelines`), so it appears as a tab in every session.
- Persistence lives in the view: it reads the session's workspace root (cwd) from
  the framework standard kit (`useSessions`), loads on mount, and saves
  (debounced) after every graph change. This survives the view tab switch that
  would otherwise drop the component-local React state.

## Install

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

3. `pnpm install` in `~/.dsh/profiles/web` (links the package into the profile's
   hoisted `node_modules`).

4. Restart the web profile. The `agent-pipeline-canvas` row mounts and the
   **Pipelines** tab appears in the session view ring.
