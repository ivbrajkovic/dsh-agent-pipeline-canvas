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
| [guide/canvas.md](guide/canvas.md) | Building a pipeline on the canvas: the palette, nodes and ports, connecting and editing, live DAG validation, the agent configuration panel (system prompt + settings), and per-repository persistence. |
| [guide/running-pipelines.md](guide/running-pipelines.md) | The run dialog and input composition, durable runs (run records, SSE, the single-active-run rule), breakpoints (pause / inspect / resume / rerun / steer / abort), restart durability and degradation, and the result modal's continue routes. |
| [guide/deployment.md](guide/deployment.md) | Installing into the DSH Web profile, the one-command sync loop, client-vs-host change handling, route verification, and the development scripts and change discipline. |

## Reference — how the plugin works

| Document | What it covers |
|----------|----------------|
| [reference/architecture.md](reference/architecture.md) | The three-face architecture (Host half, browser half, pure core), a route-by-route HTTP reference, the browser slot registrations and bundling, and the full project layout. |
| [reference/graph-and-execution.md](reference/graph-and-execution.md) | The pipeline graph schema, every `validateGraph` rule and error code, and the execution contract: per-agent input shapes, root/terminal/orphan classification, prompt framing, and the final result. |
| [reference/system-prompt.md](reference/system-prompt.md) | How the harness assembles an agent's system prompt from named sections, and the one `deployment:persona` slot that a pipeline agent's system prompt field replaces. |

Suggested reading order for a new contributor:
[README](../README.md) → [canvas guide](guide/canvas.md) →
[running guide](guide/running-pipelines.md) →
[architecture](reference/architecture.md) → the rest on demand.
Agent-oriented repo instructions live in [AGENTS.md](../AGENTS.md).
