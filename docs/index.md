# Documentation

`dsh-agent-pipeline-canvas` is a DSH Web composition plugin: a visual canvas
for building **agent pipelines** — DAGs of generic agents — and running them
through the harness's `subagents` service as **durable, steppable runs**. The
[README](../README.md) is the short overview and the fast path to a working
install; these documents are the full manual. Start here and follow the links
that match what you need — nothing requires reading everything.

## Guides — using and deploying the plugin

| Document | What it covers |
|----------|----------------|
| [guide/canvas.md](guide/canvas.md) | Building a pipeline on the canvas: the palette, nodes and ports, connecting and editing, live validation, the agent configuration panel (system prompt + settings + the port surface), and per-repository persistence. |
| [guide/running-pipelines.md](guide/running-pipelines.md) | The run dialog and input composition, the firing-kernel execution model (concurrent dispatch, fail-fast, quiescence), durable runs (the firing-log record, SSE, the single-active-run rule), grouped pause and the pending-pause queue, breakpoints (pause / inspect / resume / rerun / steer / abort), restart durability and degradation, and the result modal's continue routes. |
| [guide/pipeline-samples.md](guide/pipeline-samples.md) | Short sample graphs: sequential chains, concurrent fan-out/fan-in, any-of joins, conditional routers via output bindings, feedback loops with a bound, and steering at breakpoints. |
| [guide/deployment.md](guide/deployment.md) | Installing into the DSH Web profile, the one-command sync loop, client-vs-host change handling, route verification, and the development scripts and change discipline. |

## Reference — how the plugin works

| Document | What it covers |
|----------|----------------|
| [reference/architecture.md](reference/architecture.md) | The three-face architecture (Host half, browser half, pure core), a route-by-route HTTP reference, the browser slot registrations and bundling, and the full project layout. |
| [reference/graph-and-execution.md](reference/graph-and-execution.md) | The pipeline graph schema (ports, policies, bounds, bindings), every `validateGraph` rule and error code, the kernel's firing rules, and the firing-log run record. |
| [reference/system-prompt.md](reference/system-prompt.md) | How the harness assembles an agent's system prompt from named sections, and the one `deployment:persona` slot that a pipeline agent's system prompt field replaces. |
| [reference/design-principles.md](reference/design-principles.md) | The stream model — nodes, ports, messages, firings, quiescence — and the durable rules: self-similar boxes, honest wiring, cost discipline, the firing-log record. |

## Proposals — design background

The knowledge base behind the executor and the designs for what comes next.
The stream executor and conditional dispatch described by the first two are
**built** — the guides above describe them as shipped behavior; the
documents remain the design record.

| Document | What it covers |
|----------|----------------|
| [proposals/parallel-execution.md](proposals/parallel-execution.md) | **Built.** The stream-model executor: the firing kernel (ports, messages, firings, quiescence), fail-fast errors, grouped pause, per-node parent anchors, abort draining — plus the §8 verification matrix the implementation was held to. |
| [proposals/conditional-dispatch.md](proposals/conditional-dispatch.md) | **Built.** Conditional dispatch as base mechanics: named output ports, selective emission via bindings, declared any-of/all-of joins. |
| [proposals/if-control.md](proposals/if-control.md) | **Planned.** The if control — conditional routing as a first-class canvas node (branches owned by a visible control, schema on the producer), lowered onto the port/binding mechanics. Phased plan; each phase carries a read-before / append-after delta section. |
| [proposals/node-context-menu.md](proposals/node-context-menu.md) | **Built.** The node context menu — right-click on an agent node for **Go to transcript** (the projected child session) plus the node actions, on the harness `Menu` primitive. Phased plan; living phase-delta handoff alongside. |
| [proposals/edge-routing.md](proposals/edge-routing.md) | **Built.** Readable connection lines, two iterations: per-port ticks with sides on any node edge (a loop's ports on one vertical edge arc over or under the band), tangent-aware edge paths, and the one-per-side cap as a non-fatal warning. |
| [proposals/run-operations.md](proposals/run-operations.md) | Designed, not built: run reuse (rerun from node X), a run history browser, per-firing token accounting, and per-node timeouts — plus recorded known limits. The firing log is the foundation this builds on. |
| [proposals/per-session-pipelines.md](proposals/per-session-pipelines.md) | **Planned.** Per-session pipelines — each session owns its graph via a copy-on-write fork of the legacy workspace file, session-scoped run discovery and the single-active-run rule, and per-session load/save in the view. Phased plan; living phase-delta handoff alongside. |
| [proposals/implementation-plan.md](proposals/implementation-plan.md) | The phased build plan for the stream executor — each phase's gate, plus the append-only phase-deltas log recording where implementation met constraints. |

Suggested reading order for a new contributor:
[README](../README.md) → [canvas guide](guide/canvas.md) →
[running guide](guide/running-pipelines.md) →
[samples](guide/pipeline-samples.md) →
[architecture](reference/architecture.md) → the rest on demand.
Agent-oriented repo instructions live in [AGENTS.md](../AGENTS.md).
