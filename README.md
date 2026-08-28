# dsh-agent-pipeline-canvas

Local DSH Web composition plugin: a visual **agent-pipeline** canvas, available
in every session as a **Pipelines** view tab (beside Chat / Trajectory /
Context) and from a **Pipelines** button in the composer's tool row — the
button opens a frame-wide panel that works even on a brand-new session, where
the harness shows no view tabs at all. Build a DAG of generic agents,
then run it — each agent is delegated to the harness's own `subagents` service
in deterministic topological order (one-shot children, or continuable children
for breakpointed agents), outputs flow downstream, and the durable run returns
`{ outputs: { [terminalId]: output } }`. The graph persists per repository.

## The canvas

- Drag an **Agent** from the palette onto the canvas to add a node
  (`Agent 1`, `Agent 2`, …); reposition nodes freely; click to select.
- Drag from an agent's **output** port to another agent's **input** port to
  connect them. Edges are directed and arrow-marked; an output may **fan out**
  to many inputs, and an input may **fan in** from many sources.
- Click an agent's **edit button** (the pencil in its top-right corner) to open
  its configuration panel — a wide two-column card, everything visible. The
  left column is the agent's behavior: `name`, `description`, **system
  prompt**, and `instructions` (a plain click still selects the node).
- The right column holds the agent's **settings**: **agent options**
  (provider / model / reasoning effort / max output tokens), a **tool filter**
  (allow-only or deny, comma-separated global tool names), a **delegation-depth
  cap**, and an **output schema** (object-rooted JSON Schema). These are
  settings, not run-time overrides — they are persisted with the graph and
  shape every run of the agent. Empty fields inherit the defaults
  (provider/model from the parent session, unrestricted tools); present fields
  are forwarded to the harness subagent start request for that agent, and a
  validated
  structured result is preferred over the raw text output (rendered as JSON)
  both downstream and in the result modal.
  **Provider** and **Model** are dropdowns served by the Host's `/options`
  route: the deployment's registered LLM routes, and the selected route's
  advertised models. Both default to "inherit parent"; a saved value the
  directory no longer lists stays selectable so it is never silently lost.
- The **System prompt** field is real system-prompt text: the harness installs
  it as the agent's `deployment:persona` system-prompt section, replacing that
  one slot for this agent alone — the standard prompt (identity, policies,
  every tool explanation) is inherited untouched. See
  [docs/SYSTEM-PROMPT.md](docs/SYSTEM-PROMPT.md) for the full section layout and what is
  replaceable.
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

- **Host half** — `src/index.ts` + `src/runner.ts` + `src/runs.ts` (Node).
  Mounts as the Cordis plugin row `agent-pipeline-canvas` and registers exact
  `webServer` routes:
  - `GET|POST /dsh-agent-pipeline` — persistence. `GET ?cwd=<absolute project
    root>` reads `<cwd>/.agent-pipeline/pipeline.json` (or `null` when absent)
    and also returns `run` — the workspace's active run record (or `null`);
    `POST { cwd, graph }` writes it atomically. A relative or empty `cwd` is
    refused, so the file can only land under a real project directory. Both
    responses carry a `validation` field (the `validateGraph` result for the
    graph on disk) without changing the load/save behaviour.
  - `POST /dsh-agent-pipeline/run` — starts a durable run and returns
    `{ ok, runId }` immediately (see [Running a pipeline](#running-a-pipeline)).
  - `GET /dsh-agent-pipeline/run` — one run's full record (debug/fallback).
  - `GET /dsh-agent-pipeline/run/events` — the run's SSE stream.
  - `POST /dsh-agent-pipeline/control` — resume / rerun / steer / abort.
  - `GET /dsh-agent-pipeline/options?provider=<id>` — the registered LLM
    provider routes plus one route's advertised models, read server-side off
    the `llm` service (per-provider model catalogs are not remotely callable).
    Feeds the settings panel's Provider/Model dropdowns and degrades to
    empty lists so the fields stay free-form.
- **Browser half** — `src/client.tsx`: the Pipelines canvas, a React component
  registered into three additive slots. The per-session tab lives in
  `conversation.view` (`id: pipeline`, `order: 30`); a compact **Pipelines**
  icon button lives in the composer tool row
  (`conversation.input.left`, `id: pipeline-trigger`) — the tool row renders on
  the blank-session Hero too, so that button is the trigger that works on a
  brand-new chat — and it opens a frame-wide panel in `shell.overlay`
  (`id: pipeline-panel`) bound to the CURRENT session. The panel overlay also
  receives the root `useWorkspaces` standard hook so the view can resolve the
  pipeline's workspace. Everything is bundled by tsdown into `lib/client.js`
  in the `window.__ModuleLoader__.load(...)` format the browser module system
  consumes, and is picked into the browser roster because `package.json`
  declares `dsh.client` and `exports["./client"]`. The view reads the
  session's workspace root (cwd) from the framework standard kit
  (`useSessions`), loads on mount, and saves after every graph change — which
  is what survives the view-tab switch that would otherwise drop
  component-local React state.
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
`lib/runs.js`, `lib/storage.js`, `lib/types.js` + `.d.ts`) is emitted by tsc;
the browser bundle (`lib/client.js`) is built by tsdown.

```
dsh-agent-pipeline-canvas/
  package.json          dual-face metadata (dsh.client → browser roster), zero
                        runtime deps; typecheck/test/build scripts + devDeps
  tsconfig.json         whole-tree noEmit typecheck facade (incl. the browser client)
  tsconfig.build.json   node-half emit: src/*.ts -> lib/*.js + lib/*.d.ts (excl. client)
  tsdown.config.ts      browser bundle: src/client.tsx -> lib/client.js (module-loader format)
  src/types.ts          shared contract types (PipelineGraph / Agent / Connection,
                        validation errors+results, agent execution input, pipeline
                        execution result, runner request/result, durable run record
                        and control shapes)
  src/graph.ts          canonical graph semantics: pure validateGraph(graph) /
                        findCycle — imported by the Host, the runner, AND the
                        browser bundle (inlined by tsdown)
  src/execution.ts      canonical execution contract (pure): classification
                        (root/terminal/orphan), the per-agent input shape, the
                        default prompt framing, the deterministic run order
                        (topoOrder), and the final-result shape
  src/storage.ts        the atomic temp-file+rename write protocol shared by the
                        pipeline file and the run records
  src/index.ts          Host half: Cordis plugin row + the webServer routes
                        (persistence with atomic writes, durable run start +
                        record read + SSE stream + control, options catalog)
  src/runner.ts         per-agent primitives: runOneAgent (one-shot `spawn` child
                        with settings forwarding), startContinuableAgent /
                        steerContinuableAgent (breakpoint path), and the legacy
                        blocking runPipeline executor
  src/runs.ts           the durable run registry: per-workspace run records,
                        the sequential executor + control mailbox, the per-run
                        coordinator lifecycle, the subagent/end settlement
                        matcher, restart sweep, single-active-run rule
  src/client.tsx         browser entry: slot registration only (the components live
                        in src/ui/ — one module + one stylesheet per surface:
                        pipeline-view, agent-config, run-modal, result-modal,
                        inspect-modal, shell-panel, shared; each `.css` import
                        compiles into a tagged <style data-plugin-css> injector
                        at factory materialization, see tsdown.config.ts)
  test/validate.test.ts   validateGraph smoke tests
  test/execution.test.ts  execution-contract smoke tests
  test/runner.test.ts     runner-orchestration smoke tests
  test/runs.test.ts       durable-run tests: pause/resume, breakpoints, rerun,
                          steering, abort, restart sweep, 409, degradation
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

**Run** opens a dialog with a multiline input and workspace file attachments.
Files attach as **absolute paths** — picked from the harness's own
`@`-mention file-reference completion (type a path, click a file, descend into
directories) or pasted by hand; OS drag-and-drop of files cannot yield paths in
a browser, so a dropped file points at the picker instead. File **contents are
never inlined**: the composed input lists the paths, and the first agent reads
them with its own file tools.

The browser then POSTs `{ sessionId, cwd, graph, input }` to
`POST /dsh-agent-pipeline/run` (the graph is the snapshot the user currently
sees; `input` is the composed text+files string). The route **starts a durable
run executor in the Host process and returns `{ ok, runId }` immediately** —
the run is not tied to the HTTP request, the tab, or even the profile's
lifetime. The browser follows the run's record over
**SSE** (`GET /dsh-agent-pipeline/run/events?id=…&cwd=…`, an
`event: snapshot` full record on every connect/reconnect and an `event: update`
per transition; `EventSource` auto-reconnect self-heals a profile restart),
and a page reload re-discovers the workspace's active run through the
`run` field of `GET /dsh-agent-pipeline?cwd=…`. **One run is active
(running|paused) per workspace**; a second `POST /run` answers
`409 { ok: false, activeRunId }`. Canvas edits during a run affect only the
next run (the executor works on an immutable snapshot).

The run record persists per workspace at
`<cwd>/.agent-pipeline/runs/<runId>.json` (rewritten atomically on every
transition — same protocol as `pipeline.json`) and carries the immutable graph
snapshot, the pipeline input, the deterministic topological `order`, and one
node state per agent (`pending / running / paused / done / aborted / error`
plus the adopted `output`, the fixed composed `input`, and the agent's
`childSessionId`).

Execution (`src/runs.ts`, the run registry):

1. **Validates** the snapshot with `validateGraph` and resolves the live
   session Agent (one-shot children parent to it, unchanged).
2. **Runs each agent sequentially** in topological order (Kahn's algorithm,
   `topoOrder`): fan-in waits for all upstreams, each output flows downstream.
3. **Non-breakpointed agents** run as one-shot `subagents.start("spawn", …)`
   children — the historical path, settings forwarding unchanged.
4. **Breakpointed agents** (see below) run as **continuable** children under a
   disposable per-run **coordinator** agent, and the run **pauses** at each
   breakpoint for user inspection.
5. On a terminal state the record is finalized `completed / aborted / error`
   with all completed outputs preserved.

### Breakpoints: pause, inspect, resume / rerun / steer / abort

Each agent has a **Pause on output** breakpoint (the dot in the node's
top-left corner, or the checkbox in the edit panel). When a breakpointed
agent's output settles, the run parks before any downstream agent starts and
the inspection modal opens with the agent's composed input (fixed for the
run), its output, and the control actions:

- **Resume** — continue with the recorded output (to the next breakpoint, or
  run finalization — a breakpoint on a terminal agent pauses before that too).
  Multiple breakpoints pause independently, in topological order.
- **Rerun** — a fresh child (new `childId`; the old transcript is preserved)
  started with the node's **verbatim original input** — never steering
  content — then back to paused with the new output.
- **Steer** — deliver feedback to the **SAME** child via the harness
  continuation (`subagents.followup`, cold-resuming it from its persisted
  session — this works across profile restarts). The steering epoch's answer
  is adopted and the run stays paused; repeat indefinitely.
- **Abort** — stop the whole run: an in-flight continuable turn is interrupted
  (authorized by the durable coordinator address, so it works while the
  coordinator is disposed), the in-flight/paused node reads `aborted`, and
  completed outputs are preserved in the record.

Breakpointed agents run under a **coordinator agent** (a hidden
`origin: "subagent"` child of the session with `delegationDepth: 0`), so the
harness's settlement notices never wake the user's session with a model turn;
the coordinator handle is disposed between operations and its durable session
id is persisted in the record for post-restart steering. Continuable children
cannot produce structured output (a harness limitation), so a breakpointed
agent ignores `settings.outputSchema` — the edit panel warns when both are
set; every other setting (provider/model, tool filter, max depth, persona)
carries to the continuable request unchanged.

**Durability:** a paused run survives page reloads and profile restarts. On
the next workspace load, a record found `running` is stale (its executor died
with the previous process) and is swept to `aborted` with outputs intact; a
record found `paused` is resurrected fully controllable — the coordinator is
cold-resumed on demand and steering still reaches the same child session.

**Degradation:** continuable children require the harness continuable runtime
(`subagents.startContinuable` + session persistence, both mounted by the base
bundle). Without it the plugin still loads: breakpointed agents run one-shot
and still pause; **steering is rejected**, rerun and resume still work.

The legacy stoppable blocking POST is gone: there is no abort-on-disconnect —
runs outlive the tab by design (use **Abort**). Parallel execution, retries,
conditions, loops, and live visualization remain deliberately **not**
implemented, and the whole run halts while paused (the executor is sequential
by design — a pause stops every branch, not just one).

The parent's provider/model is inherited by each child (via the harness's
`resolveChildAgentOptions`) **unless the agent's settings say otherwise** —
per-agent provider/model/reasoning-effort/max-tokens, tool filter,
delegation-depth cap, and output schema are forwarded (see
[The canvas](#the-canvas)); the system prompt travels separately, as the
agent's first-class `systemPrompt` field (forwarded to the harness's persona
slot). The `spawn` provider is the one registered by the base bundle.

Control commands ride `POST /dsh-agent-pipeline/control`
(`{ runId, cwd, action, feedback? }` → `{ ok }` or a typed error), and the
full record is fetchable for debugging via
`GET /dsh-agent-pipeline/run?id=…&cwd=…`.

### Result & continue routes

On completion a result modal shows the terminal outputs, a per-run status
strip, and offers the continue routes — every route only **prefills a composer
and lets the user send**; nothing is ever auto-sent. Each run row also carries
a **Transcript** button (when the run published a child session): it opens the
agent's durable child session, which holds the agent's full transcript.

- **Continue in chat** — stages the final output into this session's composer
  (the standard `inputActions`) and opens the Chat tab.
- **Continue in a new session** — resolves the pipeline's workspace (its cwd
  first, then the session's own) and opens a session **attached** to it via
  `uiWorkspace.connectWorkspace`, so the chat lands in `workspace.sessionIds`
  and shows in the sidebar, then stages the output in its composer. There is
  deliberately no `sessions.create({ cwd })` fallback — a cwd-only session is
  an invisible orphan the sidebar tree can never render.
- **Send to session…** — pick one of the workspace's other sessions (same cwd,
  no subagent children or blank leftovers, id-suffixed labels) and stages the
  output there.

The routes ride minimal structural views of the client services (`sessions`,
`uiWorkspace`, `conversation.input`'s per-session shells, and the
`remote.fileReferences` picker), all declared on the client module's `inject`
(the dynamic-ctx guard rejects undeclared service access; nested Remote
namespaces need their own dotted entry). With several terminals the staged
text is one `## <agent>` section per terminal; a dismissed modal can be
reopened with the toolbar **Result** button as long as the tab stays mounted.

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

Then, after every change, run the one-command loop — it typechecks, runs the
tests, builds, and syncs the tree into the profile (stopping before the copy
if any step fails):

```
npm run sync
```

(the script wraps the plain copy, if you ever need it on its own:
`rsync -a --delete --exclude .git --exclude node_modules ./ \
  ~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/`)

Client-only changes need just the sync plus a hard browser refresh (the client
is served fresh, no cache). Host changes additionally need the user to restart
the web profile so the routes re-mount. `pnpm install` inside the profile is
currently blocked by a pre-existing supply-chain policy error
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for `dshmarket@1.34.0`); the rsync
path needs no install. After a restart, verify the route is mounted:

```
curl -s 'http://127.0.0.1:3080/dsh-agent-pipeline/run?id=x'
# {"ok":false,"error":"no such run"}  (mounted; 404 = the route answered)
```

## Development

`node_modules/` symlinks the toolchain out of the harness checkout, so the
scripts run with no install step:

```
npm run typecheck   # tsc -p tsconfig.json (whole tree, noEmit)
npm test            # plain tsx scripts: validate + execution + message + runner + runs
npm run build       # tsc -p tsconfig.build.json && tsdown → lib/
```

Change discipline, in order: edit `src/` → build → re-run the tests → sync to
the profile (above). `lib/` is committed output, so a rebuild shows up in
`git status`; semantics changes must move the tests with them. Source imports
are spelled with `.ts` extensions (`allowImportingTsExtensions` rewrites them to
`.js` on emit) — keep new imports in that style.
