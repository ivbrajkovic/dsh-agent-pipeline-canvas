# Run operations — follow-up proposals

**Status:** proposals with agreed direction. Each is independent. All follow the repo's
[design principles](../reference/design-principles.md) — in particular cost
discipline and durable truth.

These are the operational features that make runs cheaper to fix, cheaper to
understand, and easier to trust. They assume the
[parallel execution](parallel-execution.md) record model — a firing log with
per-firing outputs, statuses, child session ids — and mostly ride on
machinery that already exists.

---

## 1. Run reuse — rerun from node X without re-paying the prefix

Today the only way to retry a failed run is a new run, which re-executes and
re-pays for every node. The record already persists every node's output and
the executor already skips `done` nodes — so resuming is almost free:

- **Action:** on an errored (later: any terminal) run, "rerun from here"
  creates a **new run record seeded with the old run's completed firings** —
  outputs, stop reasons, and child session ids copied as-is — and starts the
  executor. The kernel fires only the rest.
- **Why a new record:** history stays append-only and honest; the old run is
  never mutated, and the new run links to its seed (`seedRunId`) for
  traceability.
- **Explicit, not automatic:** no hashing, no caching, no "did this node
  change" magic — the user decides what to reuse.
- Works hand-in-hand with the fail-fast error rule: a mid-pipeline failure
  costs only the nodes after the failure, not the whole graph.

## 2. Run history browser

Records accumulate per workspace in `.agent-pipeline/runs/`, but nothing can
list them — only the *active* run is discoverable today. A read-only history
panel completes the durability story:

- One GET route (`readdir` + record parse) and a small UI list: state, date,
  duration, per-node status strip, terminal outputs, transcript links.
- **Human-readable run labels** (default: the first line of the run input),
  so `a3f8c2e1…` reads as "Quarterly report analysis". Stored on the record
  at start.
- Terminal records are immutable, so the panel needs no subscriptions.

## 3. Per-node token accounting

Runs cost money; today nothing shows where it went. The Harness LLM layer
already tracks token usage (`totalTokens` exists in the llm types) — what
needs one verification pass is how usage reaches session events or the
`subagent/end` payload. Once it does:

- Record usage per firing; sum per node and per run.
- Show it in the result modal and history (a cost strip: "B: 4k · C: 31k ·
  D: 9k tokens").
- Pure visibility — no controls, no budgets; it answers "which node ate the
  budget" for the price of a field.

## 4. Per-node timeout (future knob)

A hung child — a stalled tool call or a stuck provider — parks its branch
forever; today the only remedy is manual abort. A soft timeout that fails the
node (surfaced by the fail-fast error rule) fits naturally into the
NodeRunner.

## Known limits — recorded, not fixed

- **Fan-in prompt growth.** A late node receives the *full* outputs of all
  its upstreams; deep or wide graphs balloon prompts (cost and context
  limits). The dataflow answer is authoring, not mechanism: insert a
  summarizer node before a large merge — expressible today.
- **Record write amplification.** Every transition rewrites the whole record
  atomically; large outputs × many transitions is heavy I/O. Fine at current
  scale. If it bites: outputs move to per-node files and the record keeps
  paths.

## Deliberately out

- **Inter-branch messaging.** The Harness offers `reportFrom` (a live child
  sending content to its parent mid-flight). No current need; it would add a
  channel to every layer. Revisit only with a use case in hand.
- **Live output streaming.** Streaming partial child output into the canvas
  stays deferred with the other live-visualization work; status chips and
  settlement outputs are the current contract.

## Related

- [parallel-execution.md](parallel-execution.md) — the executor and record
  model these ride on.
- [../reference/design-principles.md](../reference/design-principles.md)
