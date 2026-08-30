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
                     "inputPorts"?: [ { "name", "policy"?, "bound"? } ],
                     "outputPorts"?: [ "<name>" ],
                     "bindings"?: [ { "field", "port", "value"? } ] } ],
  "connections": [ { "id", "source", "target",
                     "sourcePort": "<source>:<outputPort>",
                     "targetPort": "<target>:<inputPort>" } ]
}
```

- `A → B` means A's output becomes input to B (an edge from one of A's output
  ports to one of B's input ports).
- Each agent has named input and output ports. Undeclared, an agent has
  **exactly one** of each — the `<id>:in` / `<id>:out` convention (declared on
  the agent as `input`/`output`). `inputPorts` declares named input ports,
  each with a delivery `policy` (`"all-of"` default, `"any-of"`) and an
  optional `bound` (positive integer); `outputPorts` declares named output
  ports; `bindings` maps a structured-output field to an output port
  (`field == value → port`; `value` omitted = catch-all; first match wins).
  A present list replaces the single default; a wire port id is
  `<agentId>:<portName>`.
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
| `connection-invalid` | A connection entry is not an object. |
| `connection-missing-source` / `connection-missing-target` | The connection names no source/target agent. |
| `connection-source-missing` / `connection-target-missing` | The referenced agent id does not exist. |
| `connection-self` | An agent connected to itself. |
| `connection-missing-source-port` / `connection-missing-target-port` | The connection names no source/target port. |
| `connection-source-port-mismatch` / `connection-target-port-mismatch` | The port is present but names none of the agent's declared (or default) output/input ports. |
| `connection-duplicate` | The same source → target edge over the same ports declared twice. |
| `cycle-present` *(warning)* | The graph contains a directed cycle — legal wiring for the stream executor; informational only. |

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

A run persists per workspace as
`.agent-pipeline/runs/<runId>.json` (`recordVersion: 2`), rewritten
atomically on every transition. The log is the run's truth — there is no
parallel per-node status bookkeeping; the per-node view is computed by
`projectNodes` (in `src/projection.ts`):

```jsonc
{
  "recordVersion": 2,
  "state": "running | paused | completed | aborted | error",
  "graph": …, "input": …, "maxInFlight": 4,
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
