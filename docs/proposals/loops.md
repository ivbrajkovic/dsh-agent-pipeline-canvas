# Loops — the conditional and the back-edge

**Status: Designed, not built.** This document pins the complete semantics
for one decision. **Extends:** [if-control.md](if-control.md) — loops are
not a new node kind; they are an if control whose branch wires backward,
plus one new value the branch condition can test. The port/binding
mechanics stay the runtime substrate, exactly as with the fork.

A flowchart loop is a decision diamond at the end of a body with one arrow
rising back into the body and one arrow leaving it. The executor already
runs that shape: cycles are legal wiring, a control's branch edges may
target any node — including an earlier one — and the loop ends when a port
goes quiet. What the engine lacks is the counter the author keeps in their
head while drawing: "run this at most three times." This proposal makes
that counter a first-class value in the branch condition, and makes its
presence on every cycle a validation invariant.

```
[Task] ──→ [Coder] ──→ [Reviewer] ──→ ⟨ if ⟩ ── retry ──→ (back to Coder)
                                    ├─ done ────→ [Polish]
                                    └─ exhausted → (optional wire)
```

The loop is the shape, not a node. One decision node, one editor, one
lowering path — the fork and the loop are the same control drawn twice.

## Design stance (pinned)

- **The if control IS the loop.** Rejected: a dedicated `Loop` control kind
  — it would duplicate the if's shape, editor, lowering, and run-state
  derivation behind a second palette brick, while every real difference
  (a required budget, a safe entry policy) is achievable as validation and
  canvas behavior on the if itself. The author's flowchart vocabulary is
  *diamond plus back-edge*; the canvas should not invent a third shape for it.
- **The counter is engine state, not a feature.** Every firing already
  carries a per-node sequence number (`seq` in the firing log; "ready order
  is node id, then per-node sequence" is a pinned kernel rule). The branch
  condition gains `$count` — the feeding agent's firing sequence for this
  firing — and one comparison operator. No cross-node reads, no delivery
  races, nothing new to store.
- **Every cycle carries its guard (error, not warning).** A directed cycle
  with no budget is a bug by definition: the runner refuses it. The guard is
  either a `bound` on a port receiving a cycle edge (existing mechanics) or
  a `$count` branch on the cycle's control (below). This is the
  enforcement of "prevent infinite loops" — the design's original goal —
  as a `validateGraph` invariant rather than an authoring promise.
- **Phased build, house discipline.** Four phases — pure core → validation →
  canvas authoring → run display + docs — each gated green (typecheck, all
  suites, build, `lib/` rebuilt; E2E in the attached Chrome for client-only
  phases). The plan and the living phase-delta handoff live at the end of
  this document.
- **Raw cycles stay legal wiring** — guarded ones. The hand-authored
  ports+bindings loop (bounds on the loop port, bindings on the tail) keeps
  working unchanged as the power path, exactly as the if control kept the
  hand-authored fork. The `cycle-present` warning stays (awareness: a loop
  exists); `cycle-unguarded` is the new error (the loop has no budget).

## Semantics

### `$count` — the firing's own sequence

- `$count` is a reserved field name. A branch row or output binding whose
  `field` is `$count` tests the **feeding agent's firing sequence for this
  firing** (1-based — the same `seq` the firing log records). At a loop
  tail the feeder fires once per iteration, so `$count` is the iteration
  number.
- `$count` is tested against the *firing*, not the structured result. It
  matches even when the firing produced no structured output — so a pure
  counter loop (`$count >= 3 → done`, catch-all → retry) needs no
  `outputSchema`, and the `if-source-no-schema` warning is suppressed when
  every valued row is a `$count` row.
- Scoping caveat, documented not solved: the count is per node per run. A
  feeder fed from several contexts counts all of its firings. For a loop
  tail — the normal shape — that is exactly the iteration count.

### The operator

- Branch rows and bindings gain an optional `op`, serialized only when
  present (the house convention for non-defaults). The minimal set:
  `==` (the default, absent key) and `>=`.
- `==` semantics are unchanged (strict equality with the existing
  `String()` coercion fallback).
- `>=` compares numerically: `Number(actual) >= Number(value)`, matching
  only when both sides coerce to finite numbers; otherwise the row does not
  match (the honest quiet). A `>=` row whose value is not a finite number
  is malformed — `if-branch-invalid`.

### The condition language is still expression-free

`A || B → done` is written as two rows over the same target:

| branch row | → target |
|------------|----------|
| `approve == true` | `done` |
| `$count >= 3` | `exhausted` (or `done` — the author's choice) |
| *(catch-all)* | `retry` |

First match wins; declaration order is the disjunction; the empty row is
the else. No `&&`, `||`, `!`, or grouping enters the schema.

### The guard rule (`cycle-unguarded`, error)

A directed cycle may run only when it carries a guard:

- **a `bound`** capping a hop of the cycle itself: for some consecutive
  hop (u → v) of the cycle path, EVERY connection u → v lands on an input
  port of v that declares a `bound` (existing delivery-cap mechanics —
  sound by construction). "Every" is load-bearing: the kernel delivers
  over each connection independently, so a bound port sharing its hop with
  an unbounded parallel edge caps nothing, and a bound on a chord that is
  not a hop of the cycle caps nothing either.
- **a `$count` escape branch** on a control lying on the cycle: a
  `$count` row whose TARGET is off the cycle, positioned before every
  branch that wires back into the cycle. Both clauses are load-bearing —
  a `$count` row shadowed by an always-matching loop row above it
  (`verdict == fix → retry` above `$count >= 3 → done`) never fires, and
  a `$count` row aimed back INTO the cycle (`$count >= 3 → retry` above a
  catch-all → retry) re-matches every firing from N on and spins forever;
  neither guards. The validation error names the rows; the editor shows
  the same diagnosis live.

The walk is the existing control-unioned `findCycle` (controls walk as
their producers; self-connections stay under `connection-self`), repeated
past each guarded cycle until no unguarded cycle remains — a graph with
two disjoint cycles needs both guarded, and one guard does not cover the
other. Equivalently implementable as a per-SCC check; the pinned semantics
are per-cycle.

Consequence, accepted: a saved graph with an unguarded cycle that ran
before now refuses to run. The issue strip names the cycle's agents and
the missing guard. The shipped Coder→Reviewer sample (`bound: 3`) stays
valid.

### The entry-port rule (`cycle-entry-all-of`, warning)

A cycle-entry input port with the default `all-of` policy and more than one
wired source (an outside seed plus the loop-back) can never satisfy — the
seed delivers once, so the body never fires at all. This is starvation,
not an infinite loop, so it warns rather than errors: the message names the
port and says to set `any-of`.

The canvas removes the need to hit it: **dropping an edge that closes a
cycle automatically sets the targeted input port to `any-of`** — declaring
`inputPorts: [{ name: "in", policy: "any-of" }]` when the agent was on the
default port, else flipping the targeted port's policy. The declaration is
a real, visible, editable graph edit (port surface, View JSON) — an assist,
not run-time magic. Automatic per decision; no prompt.

## Execution: the one core change

The kernel and executor changes are exactly:

- `Kernel.emit(nodeId, output, structured)` gains the firing's sequence
  (the executor assigns `seq` and passes it through — the kernel does not
  count anything itself).
- `evaluateBindings(bindings, structured, count)` tests a `$count` field
  against `count` **before** the no-structured-result early-out, and
  applies the `>=` numeric comparison. Everything else about selective
  emission — first match, catch-all as `value === undefined`, the honest
  quiet — is unchanged.
- `lowerControls` forwards `op` from branch rows to bindings; `$count`
  fields pass through untouched. The lowered graph of a loop-authored if is
  the hand-authored bindings twin, byte for byte, plus the `$count` rows.
- Types: `IfBranch.op?` / `OutputBinding.op?` beside the existing fields.

Nothing else moves: the firing log, the run record, `firedBranches`, and
the C3-derived control run states (idle/armed/fired/quiet) work on loop
branches unchanged — branch names are port names, `emittedTo` already
records the choice, and a control still never appears in firings, nodes,
or results.

## Canvas

- **Branch editor**: each row gains an operator picker (`==` default,
  `>=`), and the field picker offers `$count`. A `$count` row renders as
  `count >= 3 → name` on the row.
- **Backward-edge assist**: as pinned above — a cycle-closing drop sets the
  target entry port to `any-of` (and the issue strip would have warned
  otherwise).
- **Live guard diagnosis**: the issue strip's `cycle-unguarded` entry names
  the cycle and the shadowed or missing count row; a `$count` row that
  sits below a row wiring back into the cycle shows the shadowing inline.
- **Run display**: an if on a cycle shows the current iteration during a
  run — `iter 2`, promoted to `iter 2/3` when the threshold parses out of
  a `$count >= 3` row. Derived from the projection (the feeder's firing
  count), never stored — the same discipline as `firedBranches`.

## Docs checklist (definition of done)

- `reference/graph-and-execution.md`: branch `op` and `$count` in the
  schema section; `cycle-unguarded` (error) and `cycle-entry-all-of`
  (warning) in the validation table; the guard rule after the table; the
  `emit`/`evaluateBindings` contract in the kernel section.
- `guide/canvas.md`: the if section gains "the loop" — the back-edge, the
  assist, the guard error, the iteration display.
- `guide/running-pipelines.md`: quiescence section — guarded cycles,
  the unguarded refusal, `$count` semantics at a loop tail.
- `guide/pipeline-samples.md`: the Coder→Reviewer sample rewritten in the
  if-authored form as the primary; the ports+bindings twin stays as the
  documented power path.
- `reference/design-principles.md`: "bounds are core" gains its sibling —
  *every cycle carries its guard; the guard is data (a bound, a count row),
  never a node kind*.
- `index.md` proposals row flips to **Built**.

## Phased implementation plan

Four phases, each independently implementable and verifiable, each leaving
all suites green. The semantics are pinned in the sections above — those
sections are normative; this plan only sequences the work and records what
planning verified in the current tree.

### Constraints every phase assumes

- **The DeepSeek Harness repository is read-only** and needs no changes:
  structured output, subagent starts, and the breakpoint- suppresses-
  structured-output behavior are existing harness facts this design only
  consumes. Every change lands in this plugin.
- **Baseline gate, every phase**: `pnpm sync` clean — typecheck, all eight
  suites (test/canvas-graph, controls, execution, message, runner, runs,
  storage, validate; 540 checks today, growing per phase), build, `lib/`
  rebuilt. Client-only phases (L3, L4's UI half) verify in the attached
  Chrome against the rebuilt bundle with a hard refresh; host routes are
  untouched by this design, so no profile restart is needed.
- **Additive conventions**: `op` absent means `==` (the key is dropped on
  serialize — same discipline as `side`); `$`-prefixed field names are
  executor-reserved (`$input` is the precedent); the kernel stays PURE and
  total over malformed declarations (validation reports, execution skips —
  never throws); the lowered graph is never persisted and controls never
  appear in firings, nodes, or results.
- **Source-of-truth call sites** (verified in the current tree):
  - `evaluateBindings(bindings, structured)` — `src/execution.ts`; the
    catch-all test is `value === undefined`; `==` falls back to `String()`
    comparison; an early-out returns `null` when `structured` is
    null/undefined — `$count` must be tested BEFORE that early-out.
  - `Kernel.emit(nodeId, output, structured)` and
    `selectEmissionPorts(nodeId, structured)` — `src/kernel.ts`; the only
    caller is `RunExecutor.emitOutput` (`src/runs.ts`), which holds the
    `RunFiring` — `firing.seq` is the per-node, 1-based sequence
    (assigned at `seq: previous.seq + 1`).
  - Branch validation `validateBranches` and the lowering `lowerControls`
    — `src/controls.ts`; lowering already clones branch → binding per row.
  - Hand-authored binding validation — `src/graph.ts` under
    `agent-binding-invalid` / `agent-binding-port-mismatch`.
  - The cycle walk — `findCycle(agentIds, connections, sourceByControl)` in
    `src/graph.ts`, called ONCE at the end of `validateGraph`, emitting the
    `cycle-present` warning; it returns the FIRST cycle as a closed node
    path and internally builds the control-unioned adjacency (control
    edges walk from/to the producer; self-connections excluded — they stay
    under `connection-self`).
  - Branch editor — `src/ui/control-config.tsx` (`BranchRow`, `assemble()`,
    live `shapeError`s, move up/down); run-state derivation
    `controlRunState` — `src/ui/pipeline-view.tsx` (rides the source's
    LATEST firing via `firedBranches`); connections commit through the
    drafted-wire drop and the connection editor's confirm path in
    `pipeline-view.tsx`.
  - Breakpoint interplay: a breakpointed feeder emits only after a
    RELEASE, and a released firing carries no structured result. With
    `$count` tested before the early-out, a `$count` row CAN fire on
    release — deliberate, pinned by an L1 test. The
    `if-source-breakpointed` warning STAYS (pinned decision): accurate
    for content rows, stale for `$count` rows; L4's docs pass rewords the
    message. Only `if-source-no-schema` gets the suppression rule (below).

### L1 — Pure core: `$count` and `>=` in the condition language

**Scope.** The mechanism, end to end, with no UI: a hand-authored or
JSON-authored graph can loop and terminate. Nothing visual changes.

- `src/types.ts`: `IfBranch.op?: "==" | ">="` and `OutputBinding.op?:
  "==" | ">="` with doc comments pinning absent-means-`==`.
- `src/execution.ts`: `evaluateBindings(bindings, structured, count?)` —
  (a) a binding whose `field === "$count"` tests against `count` instead of
  the structured record, and this test runs BEFORE the
  no-structured-result early-out (so `$count` rows match on schema-less
  firings); (b) `op === ">="` compares `Number(actual) >= Number(value)`,
  matching only when both coerce to finite numbers, otherwise no match;
  (c) an absent or unknown `op` behaves as `==` (the kernel stays total);
  (d) ONLY `$count` rows bypass the no-structured-result early-out — a
  catch-all (`value === undefined`) still requires a structured result, so
  the honest quiet is unchanged (a released breakpointed firing with a
  plain catch-all emits nowhere); and a `$count` row with an empty or
  absent value stays a catch-all (a valueless row is the catch-all
  regardless of field — existing mechanics).
- `src/kernel.ts`: `emit()` and `selectEmissionPorts()` gain the optional
  firing sequence and pass it through. No counting logic in the kernel —
  it receives the number.
- `src/runs.ts`: the single call site `emitOutput` passes `firing.seq`.
  (The steering/Rerun re-emission path re-enters through `emitOutput` and
  is covered by the same change.)
- `src/controls.ts`: `lowerControls` forwards `op` from branch to binding;
  `validateBranches` rejects an `op` outside the set and a `>=` whose
  value is not a finite number (`if-branch-invalid`); `warnUnreachable`
  suppresses `if-source-no-schema` when every valued branch is a `$count`
  row (the breakpointed warning stays, per the constraint note).
- `src/graph.ts`: the hand-authored binding loop gains the same two `op`
  checks under `agent-binding-invalid`.

**Tests.** `execution.test.ts`: the `$count`/`>=` evaluation matrix —
numeric match, string-coerced non-match, non-finite value no-match,
`$count` matching with NO structured result, first-match-wins with mixed
content/count rows, catch-all interplay. Kernel emit plumbing (the suite
that exercises the kernel today — runner/execution tests): a `$count`
binding selects the expected port on the second firing and not the first.
`controls.test.ts`: lowering forwards `op` (and drops it when absent);
`validateBranches` op errors; the no-schema suppression. `runs.test.ts`
THE marbles: the Coder→Reviewer loop as the hand-authored twin
(`verdict == approve → result`, `$count >= 3 → exhausted`, catch-all →
feedback, any-of entry) driven through the real run path — approve on
iteration 2 exits through `result`; a never-approving reviewer exhausts at
3 with a clean `completed` and `emittedTo: ["exhausted"]`; a pure counter
loop with no `outputSchema` runs exactly 3 times. Also the if-authored
form of the same graph (controls with `op` branches) through
`lowerControls`. One more runs.test row pins the release path: a released
breakpointed firing with a `$count` binding emits on the count row (it has
no structured result) — deliberate behavior, documented in L4.

**Outcome.** A JSON-authored loop runs and terminates correctly today,
before any canvas support exists. All 540+ checks green.

### L2 — Validation: the guard rule and the entry-port warning

**Scope.** The refusal rules, in the pure core. This phase ACTIVATES the
accepted breaking change: saved unguarded cycles stop running.

- `src/graph.ts`, cycle block rewrite (keep `cycle-present` as-is):
  - Run the whole guard walk over `lowerControls(graph)` — the lowered
    graph is exactly what the kernel runs: every edge is agent → agent,
    `portGraph` answers the port-level questions directly, and the trap
    that `portGraph` DROPS control-sourced edges (unknown endpoints are
    skipped) disappears. The `cycle-present` message keeps naming agents
    only, which the lowered walk yields anyway.
  - Lift `findCycle`'s adjacency construction (or wrap it) so the walk can
    REPEAT: find a cycle; if it is guarded, exclude one of its edges and
    continue until no cycle remains or an unguarded one is found. Pinned
    semantics: every directed cycle must carry its own guard; one guard
    does not cover a second, disjoint cycle.
  - Guard test for a cycle path `[a…k, a]`, exactly per the Semantics
    section: (a) some hop (u → v) of the path where EVERY connection
    u → v lands on an input port of v declaring a `bound`, or (b) a
    `$count` branch targeting a node OFF the path, positioned before
    every branch that wires back into the path — report WHICH row
    shadows or aims in-cycle WHEN the rule fails.
  - `cycle-unguarded` ERROR naming the cycle's agents and the missing
    guard, with the fix in the message (add a bound or a `$count` row
    ahead of the loop rows).
  - `cycle-entry-all-of` WARNING: a cycle-node's input port with policy
    `all-of`, wired to two or more distinct sources, receiving at least
    one edge from the cycle — the seed-once deadlock; the message says to
    set `any-of`.
  - Scope note: the refusal covers NEW runs — `startRun` validates before
    starting, but the resurrection path re-enters `run()` without
    validation (the house validation-at-start convention), so a paused
    pre-L2 unguarded run resumes. Recorded here so no phase-delta entry
    rediscovers it.

**Tests.** `validate.test.ts` the guard matrix: bound-guarded raw cycle
valid + `cycle-present` only; unguarded raw cycle errors; control cycle
with the count row first is valid; the shadowed arrangement
(`verdict == fix → retry` above `$count >= 3 → done`) errors with the row
named; a count row above an out-of-cycle branch only is valid; `$count ==
2` as guard is valid; two disjoint cycles, one unguarded, errors; the
all-of warning fires and stays quiet under `any-of` or a single source;
self-connection still reports `connection-self` only; the shipped
Coder→Reviewer sample graph (bound 3) stays valid — regression anchor.
Soundness rows: a bound port sharing its hop with an unbounded parallel
edge does NOT guard; a bound on a chord off the cycle path does NOT
guard; a `$count` row aimed back into the cycle is NOT a guard (errors,
row named).

**Outcome.** The engine refuses unguarded loops with a precise diagnosis;
guarded graphs — both authoring forms — run unchanged. Suites green;
pure-core phase, no E2E needed beyond the existing gates.

### L3 — Canvas authoring: op picker, `$count`, the backward-edge assist

**Scope.** Client-only. Authoring a loop on the canvas requires nothing
from the port surface.

- Pure decision first (house rule — thin UI): a helper in the pure core
  (`src/graph.ts`) — given the graph and a prospective connection, returns
  whether it closes a cycle (detected on the HONEST graph via the
  control-unioned adjacency — L2's lifted machinery) and which target
  input port must flip to `any-of`: declaring
  `inputPorts: [{ name: "in", policy: "any-of" }]` only when the targeted
  wire id is the agent's default in-port (a hand-edited legacy `input`
  string can resolve to a different port id — declaring `inputPorts`
  there would orphan the existing wiring; skip the flip and let the
  warning speak), else flipping the targeted port's policy. Unit-tested
  in `canvas-graph.test.ts` / `validate.test.ts`.
- `pipeline-view.tsx`: both connection commit paths (drafted-wire drop,
  connection editor confirm — control-sourced drops always route through
  the picker) apply the helper — cycle-closing drops rewrite the target's
  port declaration in the same graph update (one commit, one persist).
  The issue strip prints validation messages verbatim (there is no
  code-to-copy map), so the two new codes surface as-is and the run
  refusal is free via the existing `!validation.ok` gate — nothing to
  build, only E2E to confirm.
- `control-config.tsx`: per-row operator picker (`==` default, `>=`);
  the field input offers `$count` (datalist suggestion + hint text; the
  row renders as `count >= 3 → name`); live `shapeError` for a `>=`
  value that is not a finite number. For the shadowing diagnosis, the
  editor receives an optional per-row warning computed in
  `pipeline-view.tsx` (which owns the graph): for each control, whether a
  branch wired back into a cycle sits above a `$count` row — shown inline
  on the offending row, matching `cycle-unguarded`'s wording.
- `View JSON` conventions verified: `op` present only when `>=`;
  `$count` rows serialize like any row.

**Tests.** Suite green including the new pure-helper tests; build; E2E in
the attached Chrome (hard refresh): author the Reviewer loop through the
editor (rows, picker, reorder), wire `retry` back to the Coder and observe
the assist flip the Coder's entry to `any-of` (agent panel + View JSON);
paste an unguarded cycle via View JSON and see `cycle-unguarded` in the
strip with the run button refusing; add the count row and watch it clear;
`>=` with a junk value shows the row error.

**Outcome.** The full flowchart authoring story works on canvas; the port
surface is never required.

### L4 — Run display, docs, scrutiny

**Scope.** The run experience and the written record.

- `pipeline-view.tsx`: extend `controlRunState` — when the control lies on
  a cycle (the L2/L3 graph facts are available; compute once per graph,
  not per render), the diamond's chip slot shows `iter N` — N = the
  feeding agent's firing count from the record's firings — promoted to
  `iter N/M` when a `$count >= M` row parses off the branches. Same
  derived-never-stored discipline; coexists with the existing warning
  chip (idle/armed/fired/quiet vocabulary unchanged).
- Docs, exactly the checklist earlier in this document:
  `reference/graph-and-execution.md` (schema `op`/`$count`; validation
  table rows `cycle-unguarded` and `cycle-entry-all-of`; the guard rule;
  the emit/evaluateBindings contract; the `if-source-breakpointed` row's
  `$count`-era reword — a released breakpointed feeder CAN fire a
  `$count` row; a VALUELESS `>=` row is malformed — validation errors on
  it, and execution's catch-all reading of the valueless row never
  applies), `guide/canvas.md` (the loop inside
  the if section: back-edge, assist, guard error, iteration display),
  `guide/running-pipelines.md` (guarded cycles, the refusal, `$count` at
  a loop tail), `guide/pipeline-samples.md` (Coder→Reviewer rewritten in
  the if-authored form as primary; the ports+bindings twin stays as the
  power path), `reference/design-principles.md` (every cycle carries its
  guard), `index.md` row flips to **Built**.
- Scrutiny pass (subagent-run scrutinize over the whole feature against
  this plan, house discipline), followed by the full E2E: build the
  Reviewer loop live in the attached browser — run it, watch `iter 1/3`
  count up and the retry edge light per pass, approve exits `done` with
  the downstream agent running; the never-approve variant exhausts at 3
  (`emittedTo: exhausted`, run `completed`, nothing dropped); an
  unguarded JSON cycle refuses to run with the strip naming the fix; a
  reload restores the graph and the last-run record identically.

**Outcome.** The feature is shipped behavior, documented, scrutinized,
all suites green, `lib/` rebuilt, index flipped.

## Phase-delta handoff (living)

Read this section before starting a phase. After finishing a phase,
append an entry ONLY if the implementation materially diverged from the
plan above — record the reason and any decision or constraint the next
phase cannot recover from this document or the code. No summaries, no
restatements of the diff.

### L1

- **The schema-less pure counter needs valued `$count` rows, not a
  catch-all.** The Semantics section's illustration (`$count >= 3 → done`,
  catch-all → retry, "needs no outputSchema") stalls under the L1-pinned
  rule that a catch-all (valueless) row still requires a structured result:
  a schema-less feeder never produces one, so that loop ends after one
  iteration. The L1 marbles run the schema-less counter as two VALUED
  `$count` rows (`$count >= 3 → done`, `$count >= 1 → retry`) — that shape
  runs exactly three times. L4's docs pass must not document the catch-all
  shape as the no-schema loop.
- **The no-schema suppression requires at least one valued branch**:
  "every valued branch is a `$count` row" is read as valued > 0, so a
  control with only a bare catch-all still warns `if-source-no-schema` —
  the catch-all needs the record, and the warning stays accurate there.
- **Validation vs lowering on the catch-all binding**: `validateGraph`
  requires every hand-authored binding to carry a non-empty `field`
  (pre-existing `agent-binding-invalid`), while the executor honors a
  fieldless binding as a catch-all and `lowerControls` emits exactly that
  when a branch authors no field. The run path is unaffected (the honest
  graph validates; the lowered graph is never validated). L2's guard walk
  runs over the LOWERED graph — do not assume every binding there carries
  a field. Nothing here yet.
