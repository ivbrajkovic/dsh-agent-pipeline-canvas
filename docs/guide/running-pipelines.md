# Running pipelines

This guide covers everything that happens around the **Run** button: the run
dialog, how a run executes as a durable, inspectable firing log, the
breakpoint controls, and what you can do with the result. For graph rules and
input shapes, see
[../reference/graph-and-execution.md](../reference/graph-and-execution.md);
for short sample graphs, see
[pipeline-samples.md](pipeline-samples.md).

## The run dialog

**Run** opens a dialog with a multiline input, workspace file attachments,
and the concurrency cap.

- Files attach as **absolute paths** — picked from the harness's own
  `@`-mention file-reference completion (type a path, click a file, descend
  into directories) or pasted by hand. OS drag-and-drop of files cannot yield
  paths in a browser, so a dropped file points at the picker instead.
- File **contents are never inlined**: the composed input lists the paths,
  and the first agent reads them with its own file tools.
- **Max agents in flight** caps how many firings run at the same time
  (default 4). It is insurance against provider rate limits and accidental
  wide fan-out; a value below 1 falls back to the default.

The browser then POSTs `{ sessionId, cwd, graph, input, maxInFlight? }` to
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
- A page reload re-discovers the session's active run through the `run`
  field of `GET /dsh-agent-pipeline?cwd=…&sessionId=…` — mid-run reloads
  re-attach and the run continues.
- When nothing is active, the same GET's `lastRun` field (the newest record
  of any state) restores the **last run's outcome** after leaving and
  re-entering the view (or a reload): the Result button returns to the
  toolbar and the nodes keep their final statuses. The result modal itself
  stays closed — reopen it with the button.
- The full record is fetchable for debugging via
  `GET /dsh-agent-pipeline/run?id=…&cwd=…`.

### The run record

The record persists at
`<cwd>/.agent-pipeline/runs/<runId>.json`, rewritten **atomically** (temp
file + rename) on every transition — the same protocol as the pipeline
files. It carries the `sessionId` it was started from (run discovery is
scoped to that session; see the single-active-run rule below). It carries:

- the immutable graph snapshot, the pipeline input, and the `maxInFlight` cap;
- the **firing log** — one entry per firing (`f-001`, `f-002`, …) with the
  node, its per-node sequence number, status
  (`pending / running / paused / done / aborted / error`), the fixed composed
  `input`, the adopted `output`, `error` + `stopReason`, the child session
  id, the selected output ports (`emittedTo`), and start/settle timestamps;
- durable executor control state per node: the node's parent-anchor session
  id (below), present only for continuable nodes;
- `pausedAt` (the paused FIRING id — the pending-pause queue head) while
  paused, and the `dropped` list of bound overflows.

There is deliberately no parallel per-node status bookkeeping — the per-node
view the UI shows is computed from the log by
[`projectNodes`](../reference/architecture.md). Canvas edits during a run
affect only the **next** run — the executor works on an immutable snapshot.
(The firing log is also the foundation
[run operations](../proposals/run-operations.md) — run reuse, history,
per-firing token accounting — will build on; that work is out of scope for
now.)

## How a run executes

The executor is the stream model's **firing kernel**: agents are nodes with
input/output ports, messages flow along connections, and a node **fires**
each time its input policy is satisfied — running its agent once.

1. **Validate** the snapshot with `validateGraph` and resolve the live
   session Agent (children parent to it, unchanged).
2. A synthetic **source** delivers the pipeline input once to every wired
   root (a node with no incoming edges), so roots fire once per run.
3. A node **fires** when its input policy is satisfied — see the firing
   rules in [graph-and-execution.md](../reference/graph-and-execution.md).
   The firing consumes its input messages, composes the prompt exactly as
   the sequential executor always did (one `## <source label>` section per
   upstream), and runs the agent as a harness `subagents` child.
4. **Ready firings start concurrently** — fan-out creates independently
   ready work, and B and C genuinely run at the same time — bounded by the
   `maxInFlight` cap. Ready order is deterministic (node id, then sequence).
5. When a firing settles `completed`, its output is emitted on its selected
   output ports and delivered downstream as new messages; when everything is
   quiet — nothing in flight, nothing fireable — the run ends
   (**quiescence**) and finalizes `completed`.

**Cycles are ordinary wiring.** A loop ends when a port goes quiet (the
reviewer emitting a verdict instead of feedback), and an input port's
**bound** — a delivery count, the loop budget — drops further arrivals and
records them in the record's `dropped` list. A graph that goes quiet with an
unfilled all-of port still finalizes `completed`, and the executor log
reports the starving nodes by name — never a silent skip.

**Errors fail the run (fail-fast, no continue-on-error).** A firing that
settles as anything but `completed` — `error`, `refusal`, `max-tokens` —
closes the halt gate run-wide, lets in-flight firings finish (the same
cost discipline as pause and abort), and finalizes the run `state: "error"`
with all completed outputs preserved. Nothing downstream of a failure
starts. The failure is live: the toolbar banner reads *Failed at
&lt;agent&gt; — finishing in-flight agents…*, the node chip shows the error,
and the record keeps the firing's `error` + `stopReason` permanently. (One
exception, on purpose: a **Rerun/Steer of a parked head** that settles
non-completed re-parks for another decision — the user is present; only
unattended firings fail the run.)

**One run is active (running|paused) per (workspace, session)**; a second
`POST /run` from the same session answers `409 { ok: false, activeRunId }`.
Different sessions in one workspace may run concurrently — the caveat is
that the two pipelines' agents can then collide on the same repository
files; the isolation is per session, not per working tree.

## Breakpoints: grouped pause, the queue, resume / rerun / steer / abort

Every agent has a **Pause on output** breakpoint (the dot in the node's
top-left corner, or the checkbox in the edit panel). Breakpointed agents run
as **continuable** children so they can be steered and interrupted.

**A pause anywhere pauses the whole parallel section.** When a breakpointed
agent's output settles:

1. the **halt gate** closes — no new firing starts anywhere (nothing
   downstream of the breakpoint runs);
2. in-flight firings **run to completion** — stopping a paid turn mid-flight
   would waste its LLM call, so their outputs are adopted and held;
3. the **inspection modal** opens for the settled firing with its composed
   input (fixed for the run), its output, and the control actions.

If several breakpoints settle while parked (both branches of a fan-out
armed), the settled-but-unresolved firings **queue**: the toolbar banner
reads *Paused at &lt;agent&gt; +N queued*, the modal shows the queue head,
and the queue is rebuilt deterministically from the firing log — which makes
it crash-safe.

| Action | What it does |
|--------|--------------|
| **Resume** | Continue with the head's recorded output — releasing it surfaces the next queued breakpoint, or the run proceeds to quiescence. |
| **Rerun** | Start a fresh firing of the same node (new child; the old transcript is preserved) with the node's **verbatim original input** — never steering content — then park again with the new output. |
| **Steer** | Send feedback to the **same** child via the harness continuation (`subagents.followup`, cold-resuming it from its persisted session — this works across profile restarts). The steering epoch's answer is adopted and the run stays paused; repeat indefinitely. Requires non-empty text. |
| **Abort** | Stop the whole run: every in-flight continuable child is interrupted, one-shot children are cancelled via the run signal, all settlements are drained (nothing commits after finalization), and completed outputs are preserved in the record. |

Rerun and steer are node-local against the paused head's child — no
interaction with other branches, which keep running (or hold their completed
outputs) independently.

### Why a parent anchor

Each continuable node owns a **parent anchor** — a hidden
`origin: "subagent"` session created lazily at the node's first continuable
admission and disposed after each start/steer. It is a durable parent
address: the header `interrupt` authorizes against it (so abort works while
the anchor is disposed) and a post-restart steer cold-resumes from it. It
costs one session record on disk and **zero model calls** — a settlement
notice can never find it live, so it can never be woken into a model turn.

### Limitations and degradation

- Continuable children cannot produce structured output (a harness
  limitation), so a breakpointed agent ignores `settings.outputSchema` — and
  its **bindings never match**, so it emits on no port. The edit panel warns
  when both are set. Every other setting (provider/model, tool filter, max
  depth, persona) carries to the continuable request unchanged.
- Continuable children require the harness continuable runtime
  (`subagents.startContinuable` + session persistence, both mounted by the
  base bundle). Without it the plugin still loads: breakpointed agents run
  one-shot and still pause; **steering is rejected**, rerun and resume still
  work.

### Durability across restarts

A run survives page reloads and profile restarts. On the next workspace
load:

- a record found `running` is **stale** (its executor died with the previous
  process) and is swept to `aborted`, outputs intact;
- a record found `paused` is **resurrected** fully controllable — and a
  firing still marked `running` from before the crash **re-fires on resume
  with its same composed input** (Rerun semantics);
- records without `recordVersion` (written by the pre-firing-log executor)
  are read-only: a stale v1 `running` sweeps to `aborted` as before, and a
  v1 `paused` record is finalized `aborted` with an explanatory error — the
  new executor cannot drive the old shape (a paused v1 run has nothing in
  flight, so the remaining cost is zero).

### Where it lives in the code

- `src/kernel.ts` — the pure firing kernel: port queues and policies,
  bounds, the halt gate, `maxInFlight`, quiescence, selective emission.
- `src/runs.ts` — the durable run registry: the kernel driver + one
  NodeRunner task per firing, the control plane (pause mailbox, queue,
  steer/rerun routing, abort drain), per-node anchor lifecycle, the commit
  writer (one chained write per transition), the restart sweep, and the
  per-session single-active-run rule.
- `src/projection.ts` — the per-node view computed from the firing log.
- `src/runner.ts` — `runOneAgent` (one-shot) and the continuable/steer
  primitives.
- `src/index.ts` — the `POST /run`, `GET /run`, `GET /run/events` (SSE), and
  `POST /control` routes.
- `src/ui/` — the breakpoint toggle and live node states
  (`pipeline-view`), the inspection modal (`inspect-modal.tsx`), the ports/
  bindings editor (`agent-config`), the run dialog's concurrency field
  (`run-modal`).
- `test/runs.test.ts` — the marble-style verification matrix: fan-in
  ordering, bounded cycles, starvation, fail-fast, abort drain with
  commit isolation, the double-breakpoint queue, `maxInFlight`, anchor
  lifecycle, determinism.

The flows are additionally verified end-to-end against the live app:
concurrent chips with strict fan-in ordering, breakpoint-while-in-flight,
the double-breakpoint queue, abort mid-fan-out, a page reload mid-run with
re-discovery, steering while the other branch is in flight, the failure
surface, and the anchor sessions' zero-model-turn guarantee.

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
status strip (a failed run shows the failure banner and the per-agent
statuses; a failed firing's transcript stays openable). Each row also
carries a **Transcript** button (when the run published a child session): it
opens the agent's durable child session, which holds the agent's full
transcript. The canvas reaches the same child session in place, without the
modal: the [node context menu](canvas.md#nodes-ports-and-connections) heads
with **Go to transcript** (right-click an agent; enabled once the node has a
child session — live, paused, and restored-last-run records all project one,
and a running one-shot node gains one only when its firing settles), and the
paused-run inspection modal carries a **Transcript** button for the parked
child. All of these ride the same open route. It hands the selection to the
child's **Chat** tab: the
conversation's view-tab selection is a per-session store, so a child whose
remembered tab is this canvas would otherwise reopen on the pipeline instead
of its transcript. The switch is requested just before the open and consumed
by the view that mounts under the child (a short self-expiry bounds the
request); on the child's own row, clicked from its own Pipelines tab, the
mounted view hands the tab over directly. The frame-wide overlay panel's
host receives no `openView`, so there the route can only close the panel
over the underlying tab.

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

Self-similar **boxes** (a graph presented as a node) are defined in the
design principles but need their own design pass;
[run operations](../proposals/run-operations.md) — run reuse, a history
browser, per-firing token accounting, timeouts — are designed but not built;
retries and live run visualization do not exist. The firing log is the
foundation that run operations will build on.
