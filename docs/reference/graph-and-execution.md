# Graph semantics & the execution contract

The formal rules behind the canvas: what a pipeline graph is, what
`validateGraph` enforces, and exactly what each agent receives and produces
at run time. Everything here is implemented once, in the pure core
(`src/graph.ts`, `src/execution.ts`, `src/kernel.ts` — see
[architecture.md](architecture.md)), and is testable with `npm test`.

## The graph schema

The pipeline is a directed graph over two arrays:

```json
{
  "agents":      [ { "id", "name", "description", "instructions",
                     "x", "y", "input": "<id>:in", "output": "<id>:out",
                     "inputPorts"?: [ { "name", "policy"?, "bound"?, "side"? } ],
                     "outputPorts"?: [ "<name>" ],
                     "outputPortSides"?: { "<name>": "side" },
                     "bindings"?: [ { "field", "port", "value"? } ] } ],
  "connections": [ { "id", "source", "target",
                     "sourcePort": "<source>:<outputPort>",
                     "targetPort": "<target>:<inputPort>" } ],
  "controls"?:   [ { "id": "if-N", "kind": "if",
                     "branches": [ { "name", "field", "value"?, "side"? } ],
                     "x", "y" } ]
}
```

- `A → B` means A's output becomes input to B (an edge from one of A's output
  ports to one of B's input ports).
- Each agent has named input and output ports. Undeclared, an agent has
  **exactly one** of each — the `<id>:in` / `<id>:out` convention (declared on
  the agent as `input`/`output`). `inputPorts` declares named input ports,
  each with a delivery `policy` (`"all-of"` default, `"any-of"`), an
  optional `bound` (positive integer), and an optional `side`;
  `outputPorts` declares named output ports, with per-port rendering sides in
  the separate `outputPortSides` map (absent entry = `"right"`);
  `bindings` maps a structured-output field to an output port
  (`field == value → port`; `value` omitted = catch-all; first match wins).
  A present list replaces the single default; a wire port id is
  `<agentId>:<portName>`.
- **Port sides are pure canvas geometry** (`"left"` / `"right"` / `"top"` /
  `"bottom"`; inputs default `left`, outputs `right`): the executor never
  reads them. At most one port of a node may occupy a side — a second port on
  a resolved side (including two ports stacked on the default) is the
  non-fatal `agent-port-side-conflict` *warning*. A loop whose two ports sit
  on the same vertical edge renders as an arc over or under the node band
  ([edge-routing](../proposals/edge-routing.md)).
- **Controls** (additive — a graph without `controls` is exactly the
  pre-control graph): first-class decision nodes, one kind in v1 — `if`. An
  if control owns its feeding agent's whole emission surface: the agent
  declares only its **output schema** (the structured result shape belongs
  to the model call), and the control's branches are the decision —
  `field == value → name` against the firing's structured result, evaluated
  in declaration order, first match wins. An absent **or empty-string**
  `value` is the catch-all and belongs last; `side` is where the branch tick
  renders on the control (default `"right"` — geometry only, the executor
  never reads it). The canvas serializes by pinned conventions: a
  control-sourced connection always names its branch as `sourcePort`
  (`"if-1:billing"`), a control-targeted connection carries **no
  `targetPort`** (the control takes a single unnamed input), and branch
  records are minimal (an empty value/field pair drops both keys, a default
  side drops `side`). A hand-authored ports+bindings graph keeps working
  unchanged — the control is an authoring upgrade over the same mechanism
  (see [the lowering contract](#the-if-control-honest-graph-lowered-execution)).
- **Fan-out** is allowed (a source id may appear in many connections);
  **fan-in** is allowed (a target id may appear in many connections — all
  edges into one port queue there).
- **Cycles are legal wiring**: the executor loops until a port goes quiet,
  and an input port's `bound` (a delivery count — the loop budget) drops and
  records further arrivals. A cycle is reported as a non-fatal
  `cycle-present` *warning* purely for the author's awareness. A
  self-connection, duplicate edge, or a reference to a missing agent/port
  remains an error.

The schema is **additive**: a graph without the new fields means one `in`
port (all-of, unbounded), one `out` port, no bindings — every pre-port
pipeline loads and runs unchanged. The default single `input`/`output`
strings stay on default graphs so old files stay byte-compatible.

## Validation: `validateGraph(graph)`

`validateGraph` (in `src/graph.ts`) returns `{ ok, errors, warnings? }`, each
error or warning `{ code, message }`; `warnings` is present only when
non-empty and never affects `ok`:

| Code | Meaning |
|------|---------|
| `graph-invalid` | The pipeline is not an object with `agents` and `connections`. |
| `agents-not-array` / `connections-not-array` | Either array is missing or not an array. |
| `agent-invalid` / `agent-missing-id` | An agent entry is not an object, or has no id. |
| `agent-duplicate-id` | Two agents share an id. |
| `agent-port-invalid` | A malformed port declaration: a legacy `input`/`output` string that is empty, or an `inputPorts`/`outputPorts` list (or one of its entries) without a usable name. |
| `agent-port-policy-invalid` | An input port's `policy` is not `"all-of"` or `"any-of"`. |
| `agent-port-bound-invalid` | An input port's `bound` is not a positive integer. |
| `agent-port-duplicate` | The same port name declared twice in one list. |
| `agent-port-side-invalid` | A port `side` / `outputPortSides` value is not one of `"left"`, `"right"`, `"top"`, `"bottom"`, or the map names a port the agent does not declare. |
| `agent-port-side-conflict` *(warning)* | More than one of the agent's ports resolves to the same node edge (including two stacked on a default) — they render stacked; assign distinct sides to spread them. |
| `control-invalid` | A malformed control record: `controls` present but not an array, an entry that is not an object, a blank or missing `id`/`kind`, a duplicate control id, or a control id colliding with an agent id (control ids live in their own space — endpoint resolution must stay unambiguous). |
| `if-source-invalid` | The control does not have exactly one incoming connection, or its feeder is another control (no control-to-control chaining). |
| `if-owner-conflict` | The feeding agent declares its own `outputPorts`/`bindings`, or has other outgoing connections — an if owns its source's whole emission surface. |
| `if-branch-invalid` | A branch rule is broken: no branches at all, an unnamed or duplicated branch name, a valued branch without a `field`, a catch-all that is not the last branch, or an unknown `side`. |
| `if-edge-port-unknown` | A control-sourced connection's `sourcePort` names no declared branch, or a control-targeted connection names a `targetPort`. |
| `if-side-conflict` *(warning)* | Two or more branches of one control resolve to the same node edge — they render stacked; assign distinct sides (mirrors `agent-port-side-conflict`). |
| `if-source-no-schema` *(warning)* | The feeding agent has no `settings.outputSchema` — the branches compare a structured result, so they can never fire. |
| `if-source-breakpointed` *(warning)* | The feeding agent is breakpointed — a continuable child cannot produce structured output, so the branches can never fire. |
| `connection-invalid` | A connection entry is not an object. |
| `connection-missing-source` / `connection-missing-target` | The connection names no source/target agent. |
| `connection-source-missing` / `connection-target-missing` | The referenced agent id does not exist. |
| `connection-self` | An agent connected to itself. |
| `connection-missing-source-port` / `connection-missing-target-port` | The connection names no source/target port. |
| `connection-source-port-mismatch` / `connection-target-port-mismatch` | The port is present but names none of the agent's declared (or default) output/input ports. |
| `connection-duplicate` | The same source → target edge over the same ports declared twice. |
| `cycle-present` *(warning)* | The graph contains a directed cycle — legal wiring for the stream executor; informational only. |

Control endpoints are **exempt from the agent port rules**: a control-targeted
edge never trips `connection-missing-target-port` (it must carry no port at
all), and a control-sourced edge's `sourcePort` is checked against the
control's declared **branches**, not agent ports. `cycle-present` unions
each control with its producer when walking, so a loop through a control
warns exactly as the lowered graph's loop would — and names agents only.

An absent/empty graph is valid — there is nothing to run.

Validation is **detection, not enforcement**: persistence writes regardless
of validity (so edits are never lost), and the runner re-validates before
running and refuses an invalid snapshot. The canvas surfaces the same result
live via its *Valid* / *N issues* chip.

## The execution contract

The runtime semantics are defined once, in the pure core: `src/execution.ts`
owns the input shape and prompt framing; `src/kernel.ts` owns the firing
rules. The contract uses **conventions over new node types / new
configuration** — every rule is derived from the existing
`agents`/`connections` arrays plus **one runtime parameter**, a
pipeline-level `pipelineInput`.

### Firing: the kernel rules

- A synthetic **source** delivers the pipeline input once to every input
  port of every **root** (a node with no incoming edges), so roots fire once
  per run. A declared input port with no edges on a node that has other
  wired ports is inert: it receives nothing and does not block.
- **all-of** (default): the node fires when every wired source of every
  all-of input port holds an unconsumed message. Consumption takes the
  oldest message per wired source — a firing composes exactly one message
  per upstream.
- **any-of**: the node fires on the arrival of any message; consumption
  takes the port's single head message — one firing per arriving message.
- **Ready order is deterministic**: node id, then per-node sequence.
- **`maxInFlight`** (default 4, per-run configurable) caps concurrent
  firings.
- **Quiescence** ends the run: nothing in flight, nothing fireable. Nodes
  that never fired and can never fire again (an unfilled all-of port) are
  reported — the run finalizes `completed` with the starvation report in the
  Host log.
- **Selective emission**: without `bindings`, a firing's output is copied to
  every edge of every output port. With bindings, the first rule matching
  the firing's **structured result** selects its port; no match — or no
  structured result — selects no port (the honest quiet; starved downstream
  nodes surface in the starvation report). A delivery a port's `bound`
  refuses is dropped and recorded.

### The if control: honest graph, lowered execution

The control is a persisted node that never runs. The run path's one
insertion sits at the top of `RunExecutor.run()` (`src/runs.ts`):
`lowerControls` (`src/controls.ts`) rewrites the honest graph onto the
port/binding mechanics — the feeding agent gains the branch names as its
`outputPorts` and the branch rules as its `bindings`, every
`K:<branch> → T:<port>` connection re-prefixes to `A:<branch> → T:<port>`,
non-default branch sides forward into the agent's `outputPortSides` (the map
omitted when it would be empty), and the control with its feeding edge
drops. The kernel consumes a graph indistinguishable from the hand-authored
twin — **decision semantics are the bindings semantics**: first match wins,
catch-all last, no match (or no structured result — e.g. a breakpointed
source) emits on no branch; the quiet branch never fires and starvation
surfaces through the existing run report.

The lowering is **total** over malformed records — a hand-edited control
normalizes or skips, never throws: the resurrection path re-enters `run()`
without passing `validateGraph`, so the lowering is the last line of
defense. A branch authored `value: ""` lowers to a binding with **no
`value` key** — the executor's catch-all test is `value === undefined`, so a
literal empty string would compare against `""` and never catch.

The lowered graph is **never persisted**: the record's `graph` snapshot
carries the honest controls (a resumed run re-enters `run()` and re-lowers
from the snapshot), while the firings, the `nodes` map, and the results name
**agents only** — a control never appears in the record. The canvas derives
a control's run display from the feeding agent's latest firing's `emittedTo`
(`firedBranches` in `src/controls.ts` — lowering names each port after its
branch, so the emission record IS the branch list): `idle` until the run
reaches the fork, `armed` while the last firing never recorded emission,
`fired` once branches were chosen, `quiet` on the decided-empty selection.

### One structured input per agent, keyed by source

**Every agent receives exactly ONE structured input — always an object keyed
by source.** One keying rule ("the source of the value") covers both a
single-upstream agent and a fan-in agent (1 key vs N keys), so the runner
never branches on "how many upstreams".

- **Root agent** (in-degree 0, includes orphans): receives the pipeline-level
  input under the reserved key `"$input"` → `{ "$input": <pipelineInput> }`.
  Every root gets the same pipeline input.
- **Single-upstream / fan-out / fan-in agent** (in-degree ≥ 1): receives
  `{ [upstreamId]: <output> }` — one key per upstream agent, in deterministic
  (sorted-by-id) order. A loop iteration delivers the upstream's newest
  firing output under the same key.

### Terminals, orphans, and the final result

- **Terminal agent** (out-degree 0): its output is part of the final result.
- **Orphan agent** (in-degree 0 **and** out-degree 0): runs as a root +
  terminal singleton — it receives the pipeline input and its output is
  collected.
- **Final result**: always `{ outputs: { [terminalId]: <output> } }` — keyed
  by terminal id (not a dedicated output node), `{}` when there are no
  terminals, and only for terminals that produced an output. A terminal that
  fired several times contributes its LAST output.

### Prompt framing

Because the harness runs an agent with a single text prompt, `agentPrompt()`
defines a deterministic default delivery form: `instructions` first, then one
`## <source label>` section per input key — each source is labelled by its
agent `name`, falling back to the id; the reserved `"$input"` key is
labelled `Input`. This is a documented convention the runner may override per
node; the input/result shapes above are the stable contract.

The per-agent `instructions`/`name`/`description` fields are reused
(instructions as the prompt seed; name/description to label a source and a
terminal). The only reserved name is `"$input"`, which cannot collide with a
canvas-generated agent id (`agent-N`; ids are not user-editable in the UI).

## The run record: a firing log

A run persists as
`.agent-pipeline/runs/<runId>.json` (`recordVersion: 2`), rewritten
atomically on every transition. The log is the run's truth — there is no
parallel per-node status bookkeeping; the per-node view is computed by
`projectNodes` (in `src/projection.ts`):

```jsonc
{
  "recordVersion": 2,
  "state": "running | paused | completed | aborted | error",
  "graph": …, "input": …, "maxInFlight": 4,   // graph = the HONEST snapshot (controls included; execution lowered it, never persisted lowered)
  "pausedAt": "f-002",                    // the paused FIRING (queue head)
  "firings": [ {
    "firingId": "f-002", "nodeId": "agent-2", "seq": 1,
    "status": "pending | running | paused | done | aborted | error",
    "input": "<composed prompt — written once, immutable>",
    "output": "…", "error": "…", "stopReason": "completed",
    "childSessionId": "…",
    "emittedTo": ["out"],                 // output ports the firing SELECTED
    "startedAt": "…", "settledAt": "…",
    "usage": {}                           // reserved (run operations, out of scope)
  } ],
  "nodes": { "agent-2": { "parentAnchorSessionId": "…" } },
  "dropped": [ { "nodeId": "agent-2", "port": "feedback", "from": "agent-3" } ]
}
```

Projection rules: a node's status is its LAST firing's status (Rerun appends
a new firing with the same immutable input; steering continues the SAME
firing's child and updates its output in place); input is the first firing's;
output/childSessionId/error are the latest defined values. `pausedAt` plus
the `paused` firings reconstruct the pending-pause queue deterministically —
that is what makes it crash-safe.

Legacy records (no `recordVersion`, the pre-firing-log sequential shape) are
**read-only**: rendering goes through the same projection; the registry
sweeps a stale v1 `running` to `aborted` and finalizes a v1 `paused` to
`aborted` with an explanatory error rather than resurrecting one.

The firing log is also the foundation
[run operations](../proposals/run-operations.md) — run reuse, a history
browser, per-firing token accounting — will build on; that work is out of
scope for now.
