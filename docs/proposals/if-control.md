# The if control — conditional routing as a first-class node

**Status:** plan, ready for phased implementation.
**Extends:** [conditional-dispatch.md](conditional-dispatch.md) — the
port/binding mechanics are **built** and stay as the runtime substrate; this
plan adds the authoring surface on top of them.

A conditional today is configured inside the producing agent's panel (output
ports + bindings + schema) while the canvas shows only anonymous wires — the
fork is invisible until a connection is drafted. The **if control** makes the
decision a node you can see and point at:

```
                 ┌── "billing" ──→ [Billing]
[Router] ──→ ⟨ if ⟩ ── "other" ───→ [General]
```

The Router agent declares only its **output schema** (the structured result
shape — that belongs to the model call). The **if control** owns the
*decision*: branches (`field == value → branch`), evaluated in order,
first match wins, one catch-all branch as the else. The branch arrows are
ordinary connections to ordinary downstream agents.

## Design stance (pinned)

- **First-class record, lowered execution.** The control is a real node in
  the persisted graph (honest wiring — the file says what the canvas shows)
  and is **lowered onto the existing port/binding mechanics** before the
  kernel runs. The kernel, the firing log's firings and nodes, storage, and
  the HTTP/SSE routes never learn controls exist (the run record's
  immutable graph snapshot carries the honest controls — it *is* the
  persisted graph; see Pinned semantics).
- **Rejected: compile-away sugar** (control only in React state, expanded at
  save time) — breaks the JSON contract and hand-edited graphs.
  **Rejected: kernel-native control firings** — phantom firings in the run
  record for a decision that costs no model call, plus a new firing
  semantics for no executor gain. **Rejected: labels-only rendering** —
  does not give the decision a home; kept as a rendering detail *inside*
  the control (one labeled tick per branch).
- **Lego bricks.** One new pure module owns the control behavior
  (`src/controls.ts` — validation-rule helpers and the lowering; the
  `ControlNode`/`IfBranch` types live in `src/types.ts` beside
  `InputPortSpec`/`OutputBinding`, the house convention for types), so it
  is testable in isolation and future controls (a `switch`, a delay)
  extend the same record shape (`kind`) without reshaping the schema.
  Each phase lands one brick behind a stable interface: pure core →
  editor → run view → docs. The kept/rebuilt boundary: the kernel,
  `storage.ts`, Host routes, and the run-record schema are KEPT untouched
  across all phases; `runs.ts` gains exactly one insertion — the lowering
  call at the top of `RunExecutor.run()` (C1) — and nothing else.

## Working context (read before starting any phase)

- **The DeepSeek Harness repository** (`~/Desktop/deepseek-harness`) is the
  source of truth for harness behavior (structured output, subagent start
  requests, breakpoints) and is **indexed by Codebase Memory** — research it
  through the code graph instead of guessing or duplicating knowledge here.
  **Never modify the Harness repository.**
- **Baseline: unit and E2E tests are all green.** `pnpm test` is the
  model-free regression net; every phase's gate requires it to stay green.
- **E2E / visual verification** runs the real UI via the **/chrome-devtools
  skill, attached to the already-running Chrome window/tab** — never a new
  browser instance. `pnpm build` remounts the bundle in the active DSH Web
  profile; host-side changes need a web-profile host restart, client-only
  changes a hard refresh (`docs/guide/deployment.md`).
- **Recently built surface this plan integrates with** (shipped behavior —
  see the guides): **edge routing** — every declared port renders as its
  own tick anchored on one of the node's four sides (`PortSide` via
  `InputPortSpec.side` / `outputPortSides`; at most one port per side,
  stacking warns `agent-port-side-conflict`-style; the edit panel's ports
  are rows with a side select); the **node context menu** — right-click a
  node for Edit / breakpoint / Delete / Go to transcript on the harness
  `Menu` primitive, with primary-button guards on the node and port
  gestures; **per-session pipelines** — the first edit in a session forks
  `pipelines/<sessionId>.json` from the legacy workspace `pipeline.json`
  (read-through until then), and the single-active-run rule binds to
  (workspace, session).
- **Additive schema** (house convention, `implementation-plan.md`): old
  pipelines load and run unchanged. A graph without `controls` is exactly
  today's graph; hand-authored ports+bindings keep working — the if control
  is an authoring upgrade over the same mechanism, not a replacement.

## Pinned schema and semantics

```ts
interface IfBranch {
    name: string;    // the branch/output-port name ("billing")
    field: string;   // structured-output field to compare ("action")
    value?: string;  // required equality; absent = catch-all (else)
                     // ("": normalizes to absent on lowering — see below)
    side?: PortSide; // node edge the branch tick renders on; absent = "right"
}                    // (geometry only — the executor never reads it)
interface ControlNode {
    id: string;              // "if-N" — separate id space from agent-N
    kind: "if";
    branches: IfBranch[];    // evaluation order = declaration order
    x: number; y: number;
}
// PipelineGraph gains: controls?: ControlNode[]
```

- **Lowering** (pure, host run path): for control `K` with source agent `A` —
  `A` gains `outputPorts = K.branches[].name` and `bindings` mapped from the
  branch rules, with one normalization: a branch authored `value: ""`
  lowers to a binding with **no `value` key** — the executor's catch-all
  test is `value === undefined` (`evaluateBindings`), so a literal empty
  string would compare against `""` and never catch. Branch `side`s
  forward into `A`'s `outputPortSides` under the house convention —
  **non-default sides only, the map omitted when it would be empty** (as
  the port editor and `buildGraph` already do) — keeping the lowered graph
  honestly equivalent to its hand-authored twin; every connection
  `K:<branch> → T:<port>` becomes `A:<branch> → T:<port>`; `K` is dropped.
  `lowerControls` is **total**: a hand-edited record's malformed controls
  normalize or skip, never throw — the resurrection path re-enters
  `run()` without validation, so the lowering is the last line of defense
  (the `portGraph` discipline). The lowered graph is exactly what
  a hand-authored P7 graph would be — the equivalence is a test. The
  lowered graph is **never persisted**: `record.graph` carries the honest
  graph **including `controls`** — required, because a resumed run
  re-enters `run()` and re-lowers from the snapshot. Controls appear in
  the record only there; firings, nodes, and results name agents only.
- **Decision semantics are the bindings semantics**: first match wins,
  catch-all last, no match (or no structured result — e.g. a breakpointed
  source cannot produce one) emits on no branch; the quiet branch never
  fires and starvation surfaces through the existing run report.
- **Prompt framing is unchanged**: the control is invisible to downstream
  prompts; the `## <source>` section is still the producing agent's name.

**Validation rules** (control-aware `validateGraph`, `{ code, message }`):

- `if-source-invalid` — a control must have exactly one incoming connection
  and its source must be an agent (no control-to-control chaining in v1).
- `if-owner-conflict` — the if **owns** the source agent's entire emission
  surface: the source declares no `outputPorts`/`bindings` of its own, feeds
  exactly this one control, and has no other outgoing edges.
- `if-branch-invalid` — at least one branch; unique non-empty **branch
  names**; every valued branch carries a non-empty `field` — branches may
  test the same field with different values (the canonical router shape)
  or mix fields; at most one catch-all and only as the last branch; an
  unknown `side` on any branch.
- `control-invalid` — a malformed control record: `controls` present but
  not an array, an entry not an object, blank or missing `id`/`kind`;
  also duplicate control ids, and control ids colliding with agent ids
  (hand-edited files) — endpoint resolution must stay unambiguous.
- warning (non-fatal, cycle-style) `if-side-conflict` — two or more
  branches of one control resolve to the same node side; the control
  renders the stack, mirroring `agent-port-side-conflict`.
- `if-edge-port-unknown` — a control-sourced connection must name a declared
  branch; a control-targeted connection must be its single input (no
  `targetPort`). The existing connection-port rules exempt control
  endpoints explicitly: `connection-missing-target-port` does not fire on
  a control-targeted edge, and `connection-source-port-mismatch` checks a
  control-sourced edge's `sourcePort` against the declared branches, not
  agent ports.
- `cycle-present` unions each control with its source agent when walking
  (a control adds no node beyond its producer), so a loop through the
  control warns exactly as the lowered graph's loop would.
- warning (non-fatal, surfaces on the control): source agent lacks
  `settings.outputSchema`, or is breakpointed — the branches can never fire.

## C1 — Pure core: schema, validation, lowering

**Goal.** The graph schema, the validator, and the run path understand
controls; the kernel consumes a lowered graph indistinguishable from a
hand-authored one. Nothing visual changes yet.

**Work items.**

- `src/types.ts` — `ControlNode`/`IfBranch` types and
  `controls?: ControlNode[]` on `PipelineGraph` (types live here per house
  convention; `controls.ts` imports them).
- `src/controls.ts` (new, pure) — control-aware validation helpers and
  `lowerControls(graph)`.
- `src/graph.ts` — `validateGraph` gains the control rules (delegating to
  `controls.ts`); existing rules extended to treat controls as connection
  endpoints (self/duplicate/missing-endpoint checks, plus the port-rule
  exemptions pinned above).
- `src/runs.ts` — the run-path seam is the **top of `RunExecutor.run()`**:
  lower `record.graph` once and use the lowered graph for `portGraph` and
  the agent/bindings resolution that follows (the bindings scan must see
  the lowered rules). This covers fresh and resumed runs by construction —
  the resurrection path re-enters `run()` and never passes `startRun`'s
  `validateGraph`, which keeps validating the HONEST graph (control-aware
  via `graph.ts`). `src/execution.ts` itself needs no change: on a lowered
  graph `portGraph`/`evaluateBindings` work as today.
- `package.json` — append `test/controls.test.ts` to the explicit `test`
  chain (a new test file otherwise never runs and the gate passes vacuously).
- `test/validate.test.ts`, new `test/controls.test.ts` — every rule fired by
  a targeted bad graph; **lowering equivalence**: the lowered sample graph
  deep-equals the hand-authored ports+bindings graph (the twin fixture
  follows the same conventions — non-default sides only, catch-all as an
  absent `value`); an empty-string branch value normalizes to a valueless
  binding; legacy graphs validate and lower to themselves.

**Verification gate.** `pnpm test` green; the equivalence test in place;
old fixtures untouched and passing.

### Delta — C1

*(append only if the implementation materially diverged from this plan —
the why, never the how; see the protocol at the end)*

## C2 — Canvas: render and author the control

**Goal.** The palette offers an **If** brick; the canvas shows the control
as a node with one labeled tick per branch; the fork is visible without
opening any panel; the persisted file is the honest graph.

**Work items.**

- `src/ui/pipeline-view.tsx` — control node rendering (kind-styled, one
  labeled tick per branch on the control's four edges — the same
  port-anchor model as agents, positioned by the branch `side`, stacking
  when two branches share a side; single input tick); drag gestures:
  branch tick → agent input opens the port picker with the branch list —
  and the picker opens for EVERY control-sourced draft, single-branch or
  not (the port-name resolvers are agent-keyed and would otherwise fall
  back to `"out"`); agent output tick → control opens the owner handoff
  (the agent must not carry its own emission config — offer to move/clear
  it, else surface `if-owner-conflict`); the primary-button gesture guards
  cover control ticks too; Delete/Clear/select cover controls.
- The right-click **node context menu** gains control entries — Edit
  branches, Delete control (no breakpoint or transcript rows: a control
  never fires a child session). This generalizes `NodeMenuTarget.agentId`
  to a node id and routes the action dispatcher by node kind; dismissal,
  clamping, and close-on-activation stay the wrapper's. All three
  agent-only touchpoints generalize with it: the vanish-cleanup effect
  must watch controls too (today it keys on `agents` alone, so a menu
  opened on a control survives that control's deletion), the entries
  computation must resolve control targets, and BOTH delete paths (the
  toolbar's and the menu's) apply the source cascade.
- New `src/ui/control-config.tsx` — the branch editor: rows of
  `name | field == value → branch` with a **side select**, reusing the
  port-row pattern (name + side) edge routing introduced in
  `src/ui/agent-config.tsx`; reorder, add/remove, catch-all-last
  constraint; warnings from the validation rules rendered on the node and
  in the panel.
- `src/ui/shared.ts` — `CanvasControl` state type (branch sides included);
  `buildGraph` emits `controls` and **special-cases control endpoints**:
  a control-targeted connection serializes with no `targetPort` (the
  unconditional default would compose `if-N:in`), and a control-sourced
  connection always carries the branch name as `sourcePort`; the load
  path restores controls and **re-seeds the `if-N` counter** from them
  (mirroring the max-id scans — Clear resets the counter, load re-seeds
  it). Also in scope, listed because every other surface is: `canvas.css`
  (control node/tick styling), the palette drop plumbing
  (`handleCanvasDrop` matches a single data type today), and the toolbar
  stat string (counts agents and connections today).
- Pinned UI semantics: deleting an agent cascade-deletes any control it
  feeds and that control's edges (a control never outlives its source);
  **Clear** resets controls state and the `if-N` counter; the existing
  duplicate-connection guard stays port-blind for v1 — two branches of one
  if to the same target are UI-blocked even though the validator would
  allow them (distinct `sourcePort`s).
- Persistence needs **no Host change** — the session-scoped route stores
  the client-composed graph verbatim, and the copy-on-write fork carries
  `controls` untouched; a virgin session reads through the legacy
  workspace graph (controls included) — client-only phase.

**Verification gate.** Unit: buildGraph/load round-trip with controls.
E2E (chrome-devtools, attached): author the Billing/General sample entirely
through the if brick — palette drag, branch editor, branch-tick wiring;
View JSON shows the honest `controls` record; reload the tab — the graph
restores identically from the session's own forked file; the node context
menu opens on a control with its two entries; `pnpm test` green.

### Delta — C2

*(append only on material divergence)*

- **C2**: the view's result-shaping path could not stay untouched as C3
  pins it: `recordToResult` classifies the record's graph snapshot for the
  result modal's runs list and contract outputs, and the snapshot is the
  HONEST graph — its control edges are not agent adjacency, so
  `classifyGraph`/`topoOrder` see the if's source as terminal and a
  control-sourced target as a root, putting the source's text output into
  the modal's outputs (a phantom contract entry the run never produced).
  `recordToResult` therefore lowers the snapshot first (`lowerControls`,
  the same rewrite the run path applies) and classifies the lowered form —
  the modal components themselves stay untouched, and controls still never
  appear in runs or outputs.

## C3 — Run experience: highlight, quiet branches, warnings

**Goal.** Running a graph with an if control behaves exactly like the
lowered bindings graph — and the canvas shows it: the control lights with
its source's firing, the chosen branch edge highlights, the quiet branch
stays visibly idle. No record or route changes.

**Work items.**

- `src/controls.ts` — tiny pure helper mapping a firing's `emittedTo`
  (already written by the P7 kernel) to the chosen branch, consumed by the
  canvas; controls never appear in firings, nodes, or results — highlight
  is derived (the record's graph snapshot intentionally carries the honest
  controls; see Pinned semantics).
- `src/ui/pipeline-view.tsx` — control node state chips (idle/armed/fired)
  from the projection + branch-edge highlighting; quiet-branch rendering;
  the run-modal and result modal are untouched (a control produces no
  output entry — assert no phantom node in the result).
- `test/runs.test.ts` — marble: an if-graph run fires only the selected
  branch; catch-all catches no-match; no-match-without-catch-all starves
  downstream and reports; a breakpointed source leaves every branch quiet.

**Verification gate.** `pnpm test` green. E2E (attached Chrome): run the
Billing/General sample with a billing question — Billing fires, General
never starts, the control + `billing` edge show it; then with a non-billing
question — the `other` branch runs. Breakpoint on the Router shows the
control's warning surface.

### Delta — C3

*(append only on material divergence)*

- **C3**: the chip vocabulary gained a fourth word: **quiet**. The plan pinned
  chips (idle/armed/fired), but a decided-empty selection (`emittedTo: []` —
  no catch-all and no match, or a breakpointed source) rendering as "fired"
  would claim a branch fired when none did, and rendering as "armed" would
  claim the decision is still pending. Quiet is the honest outcome of that
  same decision landing — not a new state machine — and the C4 docs' chip
  list must describe all four words (the plan's quiet-branch edge dimming is
  separate and unchanged).

## C4 — Docs, samples, scrutiny

**Goal.** The guides describe the if control as shipped behavior, the
reference pins the schema and rules, and an outsider-perspective review
passes. Shippable.

**Work items.**

- `docs/guide/canvas.md` — "The if control" section (palette, branch
  editor, ownership rule, warnings); `docs/guide/pipeline-samples.md` —
  the conditional-router sample rewritten in the if form (the
  direct ports+bindings form stays documented as the hand-edit variant),
  following the samples doc's per-session save-and-reload instructions.
- `docs/reference/graph-and-execution.md` — `ControlNode` schema, the
  validation rules, the lowering contract (record/report show agents only).
- `docs/index.md` — flip the already-added proposals row's status to built;
  `docs/proposals/if-control.md` status flipped to built.
- Scrutiny pass over the whole feature (trace the actual code path, not the
  diff); record verdict + constraints in C4's delta if material.

**Verification gate.** `pnpm sync` clean (typecheck + tests + build); the
full E2E pass re-run on the shipped bundle (hard refresh; host restart only
if any host file changed — none should have).

### Delta — C4

*(append only on material divergence)*

## Delta protocol

Before starting a phase, read the phase's delta section (and all earlier
ones). After finishing a phase, append one entry **only if the implementation
materially diverged from this plan** — the phase id and *why* (the constraint
discovered, the harness behavior encountered, the correctness or cost
reason). Never the what or the how — that lives in the plan, the commits, and
the code. Entries are short, append-only, never edited or removed. If nothing
material diverged, append nothing. The goal: the next phase's agent starts
knowing why the ground moved, with nothing else to read.
