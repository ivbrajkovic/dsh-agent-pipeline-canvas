# The stream executor — agreed design

**Status:** agreed design, ready for planning and implementation.
**Applies to:** the durable run executor (`src/runs.ts`) and its control
surface. Guides and references continue to describe the current sequential
executor until this lands.

**Scope:** dispatch every currently-ready agent concurrently, preserving
dependency ordering and the existing control surface. The graph itself is the
source of parallelism — fan-out creates independently ready work; fan-in waits
for all required upstream outputs. This document is the executor design: the
firing kernel and its control plane. Conditional dispatch and run operations
have their own documents; conditionals and loops are base mechanics of the
model (see [design principles](../reference/design-principles.md)).

The verification target graph:

```
       ┌→ B ─┐
A ─────┤     ├→ D
       └→ C ─┘
```

A runs first; after A completes, B and C are ready at the same time and run
concurrently as separate Harness subagents; D runs only after both complete
and receives both outputs under the existing fan-in contract; D is the
terminal output.

The design follows the repo's [design principles](../reference/design-principles.md)
— cost discipline, fail-fast errors, grouped pause, honest records.

---

## 1. The firing kernel

The current executor walks a topological `order` array one node at a time.
The redesign replaces it with the stream model's kernel
([design principles](../reference/design-principles.md)): nodes with ports,
messages, and firings.

- Each input port is a FIFO of messages with a policy — **all-of** (default)
  or **any-of** — and an optional delivery bound.
- A node **fires** when its input policy is satisfied: consume one message
  per input port, run the agent once, emit selectively to output ports. A
  node may fire many times; today's sequential pipelines are the special
  case where every input arrives exactly once.
- **Cycles are legal wiring.** A loop ends when a port goes quiet — the
  reviewer emitting a verdict instead of feedback — and a port bound caps the
  iterations. No loop construct exists.
- **Fan-in needs no new rule**: D's input port is all-of; when B's and C's
  messages have both arrived, D fires once, composed from both and rendered
  as the existing `## Beta` / `## Gamma` sections.
- **`maxInFlight` cap** (default 4, per-run configurable): new firings start
  only while fewer than N children are in flight — insurance against
  provider rate limits and accidental wide fan-out.
- **Quiescence** ends the run: nothing in flight, nothing queued. A run that
  goes quiet with starving nodes (an all-of port never filled) is a surfaced
  outcome, reported per node — never a silent skip.
- **Determinism**: same graph, same input, same agent behavior → same firing
  structure. Ready firings start in id order.

## 2. Errors fail the run (no more continue-on-error)

Today an errored node publishes no output and downstream runs with that input
key `undefined`, silently. That changes:

- A firing that does not settle as `completed` — `error`, `refusal`,
  `max-tokens`, or anything else — **fails the run**. Its `error` +
  `stopReason` are recorded on the firing; the run finalizes `state: "error"`
  with all completed outputs preserved.
- Nothing downstream of a failed node starts: no agent runs on a broken or
  partial input, and no money is spent forwarding garbage.
- The failure is surfaced, not silent: the canvas node chip and the run
  banner show the failed firing live over SSE; the record carries the error
  permanently.

One rule, no partial-output ambiguity: `completed` proceeds; everything else
fails the run.

## 3. Pause and breakpoints: grouped pause

A pause anywhere pauses the whole parallel section. A fan-out is treated as
one unit from the control surface's point of view; nothing new starts
anywhere once a breakpoint settles.

- **When a breakpoint settles:** halt all new firings immediately (the
  "nothing downstream starts" contract holds run-wide), open the inspection
  modal for that node, and let **in-flight firings run to completion** —
  stopping a paid turn mid-flight would waste its LLM call, so the only
  non-wasteful reading of pause-all is gate-plus-quiesce. In-flight outputs
  are adopted and held.
- **Resume** releases the gate; ready firings start (a fan-in still waits
  for its slowest upstream, which may have finished during the pause).
- **Several breakpoints settling while parked** (e.g. both B and C armed):
  settled-but-unresolved firings queue. `record.pausedAt` stays the queue
  head; the queue is rebuilt deterministically (id order) from the firing
  log, which makes it crash-safe. Resume / rerun / steer keep targeting the
  head; releasing it surfaces the next.
- **Rerun and steer** stay node-local against the paused head's child — no
  interaction with other branches.

### Restart rules under concurrency

- A record found `running` is swept to `aborted` exactly as today (all
  in-flight firings marked aborted, outputs intact).
- A record found `paused` is resurrected as today; a firing still marked
  `running` from before the crash is **re-fired on resume** with the same
  composed input — exactly Rerun semantics.

## 4. Abort

Unambiguous extension of today's semantics: interrupt **every** in-flight
continuable child (the single `activeChildId` becomes a set), cancel one-shot
children via the shared run signal, await all in-flight settlements (drain —
no commit may land after finalization), mark in-flight firings `aborted`,
preserve completed outputs, finalize. "Abort the whole run" stays literal.

## 5. Parent anchors (today's "coordinator", renamed)

A continuable child requires a live parent Agent for admission and interrupt
authorization, and the Harness delivers a settlement notice to that parent
**if it is live** — an idle parent gets woken with a real model turn; an
absent parent's notice is dropped silently. The current design shares ONE
coordinator per run and disposes it between operations, which both creates a
concurrency race on the shared handle (two branches' starts can interleave
ensure/resume/dispose and fail with `UNAUTHORIZED`) and leaves a window where
a settlement wakes the coordinator and burns a model call.

The redesign: **one parent anchor per continuable node**, created lazily,
held only during that node's own start/steer admission, disposed after.

- A node's anchor is only ever live during that node's own admission — and a
  child cannot settle during its own start (settlement implies its turn
  already ran). Notice and liveness windows **cannot overlap**; the wasted
  model call is unreachable by construction.
- Branches never touch each other's anchors, so there is no shared handle to
  race and **no mutex needed**.
- An anchor never receives a message: it is a durable parent address
  (authorization for `interrupt`, header for cold-resume), not a worker. It
  costs one session record on disk and **zero model calls**.
- Record change: `coordinatorSessionId` moves from the run record into
  `RunNodeState` (present only for continuable nodes) — the node owns its
  parent.
- Terminology: the code and guides say "coordinator" today; this work renames
  it to **parent anchor** everywhere it touches.

## 6. Modularity (the executor rewrite)

Implementation is a rewrite of `RunExecutor`'s internals, decomposed into
four small pieces. Promise-per-node readiness is the idiom; generators and
explicit async queues add machinery without removing complexity.

| Piece | Responsibility |
|-------|----------------|
| **Kernel** | Pure stream mechanics: port queues and policies, firing rules, the halt gate, `maxInFlight`, quiescence detection. Unit-testable with no I/O. |
| **NodeRunner** | One async task per firing: await the firing's inputs → compose → run (one-shot or continuable epoch) → emit to output ports → report terminal. Per-firing error attribution. |
| **ControlPlane** | The pause mailbox and queue head, abort state, steer/rerun routing. |
| **Commit writer** | Every record mutation flows through one `transition()` that chains writes and notifies subscribers — concurrent branches cannot interleave atomic renames (today two concurrent `commit()` calls could race a stale snapshot into the file). |

## 7. Kept vs. rebuilt

**Kept — the hard parts:**

- The Harness, untouched. Verified facts this design relies on: concurrent
  one-shot and continuable starts are uncapped and independent; `subagent/end`
  fires per child with epoch-relative output; `interrupt` authorizes per child
  against the durable parent header and works while the anchor is disposed.
- The per-run primitives: `runOneAgent`, `startContinuableAgent`,
  `steerContinuableAgent` — already per-firing by nature.
- `EndWaiter` (per-child id matching, buffered) — handles any number of
  overlapping settlements.
- Per-workspace storage protocol, the HTTP/SSE routes, the single-active-run
  rule, and the results-to-chat routes.
- The control-plane rules in §2–§5.

**Rebuilt from the model's axioms:**

- **Validation**: cycles are legal wiring; the rules become port-wiring
  correctness (known agents and ports, no duplicate edges, valid policies and
  bounds). Cycle rejection is gone.
- **The record**: a firing log replaces per-node slots (`nodes[id]` → entries
  per firing, each with input, output, child session, stop reason, cost).
- **The node model**: named ports with policies and bounds replace the single
  `<id>:in` / `<id>:out` pair.
- **The executor**: the sequential `order` walk is replaced by the kernel.

The graph schema changes are additive: ports, policies, and bounds as fields
on agents and connections. Today's single-port graphs remain valid under the
defaults (one `in`, one `out`, all-of, unbounded).

## 8. Verification

### Unit (scripted harness in `test/runs.test.ts`)

Tests are **marble-style** (the ReactiveX testing pattern): scripted message
injection in a fixed order, then assert the resulting firing log — no live
model anywhere. The existing `makeHarness().settle()` is the seed of this.

- Settle B and C out of order → D fires once, after the second; D's prompt
  contains both `## Beta` and `## Gamma` sections.
- A cycle (Coder → Review → Coder via a feedback port) with a bound: fires
  until the Review emits only on its result port (quiescence), or the bound
  drops the message (recorded overflow).
- Starvation: an all-of port never filled → run goes quiet; the report lists
  the waiting node.
- A firing fails → run finalizes `error`; downstream never fires; completed
  outputs preserved; failure surfaced on the firing.
- Abort mid-fan-out → both continuable children interrupted, one-shot
  children cancelled, drain before finalize, no post-finalize commits.
- Double-breakpoint queue → two parks, id-order release.
- `maxInFlight` respected under a wide fan-out.
- Anchor lifecycle: per-node creation, disposal after admission, no live
  anchor at any settlement.
- Commit writer: concurrent firings never interleave record writes.

### Live (DSH UI, via /chrome-devtools attached to the running app)

- A→B,C→D with no breakpoints: both chips `running` together; D strictly
  after both; result modal shows D.
- Breakpoint on B while C runs: dispatch gated, modal at B's settle, C
  finishes and holds, resume completes.
- Breakpoints on both B and C: queue behavior.
- Abort mid-fan-out; page reload during fan-out; steer while the other branch
  is in flight.
- Check the anchor sessions for any settlement-notice turns (should be
  unreachable — verify).

## Related

- [conditional-dispatch.md](conditional-dispatch.md) — selective emission and
  port policies: conditionality as base mechanics.
- [run-operations.md](run-operations.md) — run reuse, history, token
  accounting, timeouts.
- [../reference/design-principles.md](../reference/design-principles.md) —
  the stream model and the rules this design follows.
