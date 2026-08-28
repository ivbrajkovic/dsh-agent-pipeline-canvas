# Graph semantics & the execution contract

The formal rules behind the canvas: what a pipeline graph is, what
`validateGraph` enforces, and exactly what each agent receives and produces
at run time. Everything here is implemented once, in the pure core
(`src/graph.ts`, `src/execution.ts` — see
[architecture.md](architecture.md)), and is testable with `npm test`.

## The graph schema

The pipeline is a directed acyclic graph (DAG) over two arrays:

```json
{
  "agents":      [ { "id", "name", "description", "instructions",
                     "x", "y", "input": "<id>:in", "output": "<id>:out" } ],
  "connections": [ { "id", "source", "target",
                     "sourcePort": "<source>:out", "targetPort": "<target>:in" } ]
}
```

- `A → B` means A's output becomes input to B (an edge from A's output port
  to B's input port).
- Each agent has **exactly one** input port and one output port, named by the
  `<id>:in` / `<id>:out` convention (declared on the agent as
  `input`/`output`).
- **Fan-out** is allowed (a source id may appear in many connections);
  **fan-in** is allowed (a target id may appear in many connections).
- A node with no incoming edges is a **start** node; a node with no outgoing
  edges is a **terminal** node. A node runs only after every incoming
  dependency has produced its output. There are no explicit parallel/join
  node types.
- A cycle, self-connection, duplicate edge, or a reference to a missing
  agent/port is an error.

## Validation: `validateGraph(graph)`

`validateGraph` (in `src/graph.ts`) returns `{ ok, errors }`, each error
`{ code, message }`:

| Code | Meaning |
|------|---------|
| `graph-invalid` | The pipeline is not an object with `agents` and `connections`. |
| `agents-not-array` / `connections-not-array` | Either array is missing or not an array. |
| `agent-invalid` / `agent-missing-id` | An agent entry is not an object, or has no id. |
| `agent-duplicate-id` | Two agents share an id. |
| `agent-port-invalid` | An agent's declared `input`/`output` port does not follow the `<id>:in` / `<id>:out` convention. |
| `connection-invalid` | A connection entry is not an object. |
| `connection-missing-source` / `connection-missing-target` | The connection names no source/target agent. |
| `connection-source-missing` / `connection-target-missing` | The referenced agent id does not exist. |
| `connection-self` | An agent connected to itself. |
| `connection-missing-source-port` / `connection-missing-target-port` | The connection names no source/target port. |
| `connection-source-port-mismatch` / `connection-target-port-mismatch` | The port is present but is not the agent's declared `<id>:out` / `<id>:in`. |
| `connection-duplicate` | The same source → target edge declared twice. |
| `cycle` | The graph contains a directed cycle (`findCycle`). |

An absent/empty graph is valid — there is nothing to run.

Validation is **detection, not enforcement**: persistence writes regardless
of validity (so edits are never lost), and the runner re-validates before
running and refuses an invalid snapshot. The canvas surfaces the same result
live via its *Valid* / *N issues* chip.

## The execution contract

The runtime semantics the runner relies on are defined once, in the pure
`src/execution.ts`, so they are stable and testable. The contract uses
**conventions over new node types / new configuration** and requires **no
persisted schema change** — every rule is derived from the existing
`agents`/`connections` arrays plus **one runtime parameter**, a
pipeline-level `pipelineInput`.

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
  (sorted-by-id) order.

### Terminals, orphans, and the final result

- **Terminal agent** (out-degree 0): its output is part of the final result.
- **Orphan agent** (in-degree 0 **and** out-degree 0): runs as a root +
  terminal singleton — it receives the pipeline input and its output is
  collected.
- **Final result**: always `{ outputs: { [terminalId]: <output> } }` — keyed
  by terminal id (not a dedicated output node), `{}` when there are no
  terminals, and only for terminals that produced an output.

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
