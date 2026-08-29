# Running pipelines

This guide covers everything that happens around the **Run** button: the run
dialog, how a run executes as a durable, inspectable record, the breakpoint
controls, and what you can do with the result. For graph rules and input
shapes, see [../reference/graph-and-execution.md](../reference/graph-and-execution.md).

## The run dialog

**Run** opens a dialog with a multiline input and workspace file attachments.

- Files attach as **absolute paths** — picked from the harness's own
  `@`-mention file-reference completion (type a path, click a file, descend
  into directories) or pasted by hand. OS drag-and-drop of files cannot yield
  paths in a browser, so a dropped file points at the picker instead.
- File **contents are never inlined**: the composed input lists the paths,
  and the first agent reads them with its own file tools.

The browser then POSTs `{ sessionId, cwd, graph, input }` to
`POST /dsh-agent-pipeline/run` — the graph is the snapshot the user currently
sees; `input` is the composed text+files string. (How that input reaches each
agent is the [execution contract](../reference/graph-and-execution.md).)

## Durable runs

The run route **starts a durable run executor in the Host process and returns
`{ ok, runId }` immediately**. The run is not tied to the HTTP request, the
tab, or even the profile's lifetime — runs outlive the tab by design (use
**Abort** to stop one; there is no abort-on-disconnect).

### Following a run

- The browser follows the run's record over **SSE**
  (`GET /dsh-agent-pipeline/run/events?id=…&cwd=…`): an `event: snapshot`
  full record on every connect/reconnect and an `event: update` per
  transition. `EventSource` auto-reconnect self-heals a profile restart.
- A page reload re-discovers the workspace's active run through the `run`
  field of `GET /dsh-agent-pipeline?cwd=…`.
- The full record is fetchable for debugging via
  `GET /dsh-agent-pipeline/run?id=…&cwd=…`.

### The run record

The record persists per workspace at
`<cwd>/.agent-pipeline/runs/<runId>.json`, rewritten **atomically** (temp
file + rename) on every transition — the same protocol as `pipeline.json`.
It carries:

- the immutable graph snapshot and the pipeline input;
- the deterministic topological `order`;
- one node state per agent: `pending / running / paused / done / aborted /
  error`, plus the adopted `output`, the fixed composed `input`, and the
  agent's `childSessionId`.

Canvas edits during a run affect only the **next** run — the executor works
on an immutable snapshot.

### Execution, step by step

1. **Validate** the snapshot with `validateGraph` and resolve the live
   session Agent (one-shot children parent to it, unchanged).
2. **Run each agent sequentially** in topological order (Kahn's algorithm,
   `topoOrder`): fan-in waits for all upstreams, each output flows downstream.
3. **Non-breakpointed agents** run as one-shot `subagents.start("spawn", …)`
   children of the session agent.
4. **Breakpointed agents** run as **continuable** children under a disposable
   per-run **coordinator** agent, and the run **pauses** at each breakpoint
   for user inspection (below).
5. On a terminal state the record is finalized `completed / aborted / error`
   with all completed outputs preserved.

**One run is active (running|paused) per workspace**; a second `POST /run`
answers `409 { ok: false, activeRunId }`. The executor is currently
sequential: pausing at a breakpoint stops every branch, not just one
([concurrent dispatch is designed](../proposals/parallel-execution.md), with
pauses gating the whole parallel section).

## Breakpoints: pause, inspect, resume / rerun / steer / abort

Every agent has a **Pause on output** breakpoint (the dot in the node's
top-left corner, or the checkbox in the edit panel). When a breakpointed
agent's output settles, the run parks **before any downstream agent starts**,
and the inspection modal opens with the agent's composed input (fixed for the
run), its output, and the control actions:

| Action | What it does |
|--------|--------------|
| **Resume** | Continue with the recorded output — to the next breakpoint, or run finalization. A breakpoint on a terminal agent pauses before finalization too. Multiple breakpoints pause independently, in topological order. |
| **Rerun** | Start a fresh child (new `childId`; the old transcript is preserved) with the node's **verbatim original input** — never steering content — then park again with the new output. |
| **Steer** | Send feedback to the **same** child via the harness continuation (`subagents.followup`, cold-resuming it from its persisted session — this works across profile restarts). The steering epoch's answer is adopted and the run stays paused; repeat indefinitely. Requires non-empty text. |
| **Abort** | Stop the whole run: an in-flight continuable turn is interrupted (authorized by the durable coordinator address, so it works while the coordinator is disposed), the in-flight/paused node reads `aborted`, and completed outputs are preserved in the record. |

### Why a coordinator

Breakpointed agents run under a **coordinator agent** — a hidden
`origin: "subagent"` child of the session with `delegationDepth: 0` — so the
harness's settlement notices never wake the user's session with a model turn.
The coordinator handle is disposed between operations, and its durable
session id is persisted in the record for post-restart steering.

### Limitations and degradation

- Continuable children cannot produce structured output (a harness
  limitation), so a breakpointed agent ignores `settings.outputSchema` — the
  edit panel warns when both are set. Every other setting
  (provider/model, tool filter, max depth, persona) carries to the
  continuable request unchanged.
- Continuable children require the harness continuable runtime
  (`subagents.startContinuable` + session persistence, both mounted by the
  base bundle). Without it the plugin still loads: breakpointed agents run
  one-shot and still pause; **steering is rejected**, rerun and resume still
  work.

### Durability across restarts

A paused run survives page reloads and profile restarts. On the next
workspace load:

- a record found `running` is **stale** (its executor died with the previous
  process) and is swept to `aborted`, outputs intact;
- a record found `paused` is **resurrected** fully controllable — the
  coordinator is cold-resumed on demand and steering still reaches the same
  child session.

### Where it lives in the code

- `src/runs.ts` — the run registry: executor loop + control mailbox, record
  persistence, coordinator lifecycle, restart sweep, single-active-run rule.
- `src/runner.ts` — `runOneAgent` (one-shot) and the continuable/steer
  primitives.
- `src/index.ts` — the `POST /run`, `GET /run`, `GET /run/events` (SSE), and
  `POST /control` routes.
- `src/ui/` — the breakpoint toggle and live node states
  (`pipeline-view`), the inspection modal (`inspect-modal.tsx`), the config
  checkbox (`agent-config`).
- `test/runs.test.ts` — the scripted control-plane suite (pause ordering,
  rerun/steer/abort, restart sweep, 409, coordinator disposal, degradation).

The breakpoint flows are additionally verified end-to-end against the live
app: pause + inspection, rerun, repeated steering with transcript
continuation, resume through the rest of the graph, abort preservation,
multiple breakpoints pausing in sequence, page-reload discovery, and a paused
run surviving a profile restart with steering still reaching the same child.

## Inheritance and settings forwarding

The parent's provider/model is inherited by each child (via the harness's
`resolveChildAgentOptions`) **unless the agent's settings say otherwise** —
per-agent provider/model/reasoning-effort/max-tokens, tool filter,
delegation-depth cap, and output schema are forwarded (see
[canvas.md](canvas.md#right-column--settings)); the system prompt travels
separately, as the agent's first-class `systemPrompt` field (forwarded to the
harness's persona slot). The `spawn` provider is the one registered by the
base bundle.

## Control and record APIs

Control commands ride `POST /dsh-agent-pipeline/control`
(`{ runId, cwd, action, feedback? }` → `{ ok }` or a typed error), where
`action` is one of `resume / rerun / steer / abort`. The full record is
fetchable for debugging via `GET /dsh-agent-pipeline/run?id=…&cwd=…`.

## Results and the continue routes

On completion a **result modal** shows the terminal outputs and a per-run
status strip. Each run row also carries a **Transcript** button (when the run
published a child session): it opens the agent's durable child session, which
holds the agent's full transcript.

The modal offers three continue routes — every route only **prefills a
composer and lets the user send**; nothing is ever auto-sent:

- **Continue in chat** — stages the final output into this session's composer
  (the standard `inputActions`) and opens the Chat tab.
- **Continue in a new session** — resolves the pipeline's workspace (its cwd
  first, then the session's own) and opens a session **attached** to it via
  `uiWorkspace.connectWorkspace`, so the chat lands in
  `workspace.sessionIds` and shows in the sidebar, then stages the output in
  its composer. There is deliberately no `sessions.create({ cwd })` fallback
  — a cwd-only session is an invisible orphan the sidebar tree can never
  render.
- **Send to session…** — pick one of the workspace's other sessions (same
  cwd, no subagent children or blank leftovers, id-suffixed labels) and stage
  the output there.

With several terminals the staged text is one `## <agent>` section per
terminal. A dismissed modal can be reopened with the toolbar **Result**
button as long as the tab stays mounted. The routes ride minimal structural
views of the client services (`sessions`, `uiWorkspace`,
`conversation.input`'s per-session shells, and the `remote.fileReferences`
picker), all declared on the client module's `inject`.

## What is deliberately not implemented

Loops, retries, and live visualization do not exist yet. The executor is
currently sequential: a pause halts the whole run.

Designs for execution beyond sequential runs live in
[docs/proposals/](../proposals/parallel-execution.md): the stream-model
executor (nodes wired through ports, firing as data arrives, cycles as
ordinary wiring),
[conditional dispatch](../proposals/conditional-dispatch.md) (named output
ports with selective emission), and
[run operations](../proposals/run-operations.md) (run reuse, history, token
accounting). Until they are implemented, this guide describes exactly how
runs behave today.
