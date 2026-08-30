# The stream executor — phased implementation plan

**Status:** plan, ready for phased implementation.
**Implements:** [parallel-execution.md](parallel-execution.md) (the executor
spec) plus the node-model parts of [conditional-dispatch.md](conditional-dispatch.md).
[run-operations.md](run-operations.md) stays **out of scope**; where the
firing-log record already supports it, the plan says so and moves on.

The design documents are settled; this plan does not re-argue them. Each phase
ends with something runnable and verified — no phase only reshapes internals.
The kept/rebuilt boundary of spec §7 holds throughout: the Harness, the
per-run primitives (`runOneAgent`, `startContinuableAgent`,
`steerContinuableAgent`), `EndWaiter`, the storage protocol, the HTTP/SSE
routes, and the results-to-chat routes are KEPT; validation, the record, the
node model, and the executor are REBUILT.

## Phase deltas

- **P2** — the v2 `RunRecord` sketch says "minus `coordinatorSessionId`", but the
  same sketch leaves the anchor map empty until P4 and the P2 gate requires the
  restart scenarios green — post-restart steering cold-resumes the coordinator
  from its persisted id, so with the field removed that gate is unsatisfiable.
  The field stays on the record through P2 (and P3); P4 removes it when
  `nodes[id].parentAnchorSessionId` takes over, as P4's work items already say.
- **P3** — the plan's all-of rule ("every wired input port holds an unconsumed
  message") is per-port, which cannot express this phase's own fan-in gate:
  B and C share D's single default port, so a per-port rule fires D on the
  first arrival and again on the second. The rule landed per WIRED SOURCE
  within each port (consume the oldest message per source — exactly the input
  contract's one-key-per-upstream shape); any-of consumes the port's single
  head message and never blocks. Also: the quiescence starving report surfaces
  through the executor log, not a new record field (the P2-pinned record
  schema stays untouched), restart does not reconstruct kernel queue state
  (nodes the log marks done never re-fire; P5's pending-pause queue owns
  crash-safe reconstruction), and the settled-breakpoint FIFO is P5 surface
  landed early in minimal in-memory form because concurrent branches can
  settle while parked. En route: Windows intermittently EPERMs the atomic
  rename's rename leg (storage.ts now retries), and terminal finalization had
  to await its commit before the executor leaves the registry — otherwise a
  concurrent workspace load sweeps the stale `running` disk snapshot over a
  completed run.
- **P3 (scrutiny)** — two constraints surfaced by the post-implementation
  review, recorded so later phases inherit them honestly: (1) the accepted
  shared-coordinator race (P4 removes it) is worse than a wasted handle — two
  breakpointed branches admitted in the same batch can each create a
  coordinator, leaving one handle undisposed and LIVE (a settlement notice can
  wake it with a real model call) and one child parented to a session other
  than `coordinatorSessionId`; reachable the moment both branches of the
  verification graph are breakpointed, which the P3 E2E gate dodges only by
  using one-shot graphs. (2) The port bound is a BACKLOG cap (max unconsumed
  queued messages — the P1 wording types.ts pinned), while design principle 4
  and P7's loop-budget gate describe a DELIVERY count; in a free-running cycle
  a backlog bound never overflows, so P7's "bound drops + records overflow"
  cannot pass as coded. Decide the bound semantics before P7 builds on it.
- **P4** — the work items cover fresh runs only, but a record written by a
  P2/P3 build parks a child whose durable parent is the shared
  `coordinatorSessionId`; a freshly created per-node anchor would break that
  child's post-restart steer authorization. The first anchor a node needs
  therefore adopts the shared id and retires the field — check-and-adopt
  inside one write-chain transition, so two nodes can never claim it. En
  route: same-node admissions serialize on a per-node chain
  (`fireableNodes()` does not exclude in-flight nodes, so cyclic re-feed makes
  concurrent same-node firings reachable before P7), and steering both parked
  branches after a restart stays P5 surface (a resurrected record re-parks
  only the `pausedAt` head), so "cold-resume per node after restart" is
  pinned for the parked node's own anchor.
- **P4 (scrutiny)** — the post-implementation scrutiny verdict was ship, with
  one constraint recorded so P5 inherits it honestly: legacy adoption is
  FIRST-CLAIM-WINS (delete-on-claim). Unreachable as coded — the resurrected
  `pausedAt` head is the only pre-P4 node that can admit — but P5's
  pending-pause queue will make a second pre-P4 parked branch steerable, and
  its first admission then creates a fresh anchor whose id does not match
  that branch child's durable `parentSession` header: every steer of that
  child fails `UNAUTHORIZED` forever (Rerun still works — a fresh child is
  stamped with the fresh anchor id). Decide before P5: keep the legacy field
  as a fallback address for not-yet-anchored nodes, or accept
  steer-via-Rerun-only for later pre-P4 branches.
- **P5** — the P4-scrutiny decision lands as: steer-via-Rerun-only for later
  pre-P4 branches. Keeping the shared id as a fallback address would put a
  shared live-anchor address back into the admission hot path — the exact
  race P4 removed — to serve only transitional (P3-era) records whose failing
  steer is typed, surfaced on the firing, and fully recoverable via Rerun.
- **P5 (scrutiny)** — verdict ship with constraints. (1) A reachable
  park-invariant window in the re-fire path: when a resumed head surfaces an
  orphaned breakpointed node whose re-fire epoch is still in flight,
  `pausedAt` re-points at the fresh RUNNING firing while the record claims
  paused, and the surfaced entry arms its mailbox only when the epoch
  settles — until then every resume/rerun/steer is rejected with the typed
  not-parked error while the UI shows the modal. Accepted as bounded (one
  epoch), self-healing (the epoch's settle re-arms), abort-safe (abort is
  accepted throughout), and coherent across a second crash (the running
  firing re-fires again); later phases must not assume the invariant holds
  in the crash-recovery path. Cheap fixes if it ever matters in practice:
  gate the modal actions while the pausedAt firing's status is "running", or
  defer the orphan's re-fire until its entry surfaces. (2) For P7: the
  rebuilt queue sorts firing ids lexicographically over 3-digit padding —
  switch to a numeric compare on the id suffix before loops can exceed 999
  firings.

Protocol: before starting a phase, read this log first. After finishing a
phase, append one entry **only if the implementation materially diverged from
the plan** — the phase id and *why* (the constraint discovered, the harness
behavior encountered, the cost or correctness reason). Never the what or the
how; that lives in the plan, the commits, and the code. Entries are short,
append-only, and never edited or removed. If nothing material diverged,
append nothing.

---

## Conventions used by every phase

**Verification is two-tier.** Unit tests are marble-style: scripted message
injection in a fixed order against the kernel/executor with the scripted
harness from `test/runs.test.ts` (`makeHarness()` + `settle()`), then assert
the firing log — no live model. E2E checks run the real UI via /chrome-devtools
attached to the already-running Chrome: `pnpm build` remounts the bundle in the
active DSH Web profile; host-side changes need a web profile host restart,
client-only changes a hard refresh (`docs/guide/deployment.md`). A phase is
done when its gate passes (`pnpm test` green + the listed checks).

**Additive schema.** Every graph-schema change keeps old pipelines loading and
running: a graph without the new fields means one `in` port (all-of,
unbounded), one `out` port, no bindings. `buildGraph` keeps emitting the
legacy `input`/`output` fields for default graphs.

**Run-record versioning.** The new record carries `recordVersion: 2`. Legacy
records (no `recordVersion`) keep their current reader path: `running` sweeps
to `aborted` exactly as today; a legacy `paused` record is finalized `aborted`
with an explanatory error instead of being resurrected — the new executor
cannot drive the old shape, and a paused run's remaining cost is zero (nothing
in flight). See P2.

**Determinism.** Same graph, same input, same agent behavior → same firing
structure. Ready firings start in node-id order, then per-node sequence.

---

## P1 — Stream graph schema + port validation

**Goal.** The persisted graph can express the stream model — named input ports
with policies and bounds, named output ports — and `validateGraph` enforces
port-wiring correctness instead of acyclicity. Old single-port graphs validate
and run exactly as before; nothing executes differently yet (the sequential
executor keeps using the derived single-port view).

**Work items.**

- `src/types.ts` — additive agent fields (spec §7 "the node model",
  conditional-dispatch §2):
  - `inputPorts?: InputPortSpec[]` — `{ name, policy?: "all-of" | "any-of", bound?: number }`;
  - `outputPorts?: string[]`;
  - legacy `input`/`output` strings remain the default port names; absent
    lists derive `{ name: "in", policy: "all-of" }` and `["out"]`.
- `src/graph.ts` — new validation rules; cycle rejection is **removed**
  (cycles are legal wiring, spec §7). Port-wiring correctness: known agents
  and ports (a connection's `sourcePort`/`targetPort` must name declared or
  default ports), no duplicate edges, valid policies (`all-of` | `any-of`) and
  bounds (positive integers), no duplicate port names. New error codes keep
  the `{ code, message }` shape.
- `src/execution.ts` — a pure `portGraph(graph)` helper: per-port incoming
  edges, resolved policies/bounds, default derivation. Validation and (later)
  the kernel share it.
- `test/validate.test.ts` — new cases; existing cases adjusted only where they
  asserted cycle rejection.

**Verification gate.** Unit: old fixture graphs validate unchanged; named-port
graphs (including a legal cycle) validate; every new error code fired by a
targeted bad graph; `pnpm test` fully green (the sequential runner still runs
default graphs — behavior unchanged).

**Risks / open details.** The sequential executor and `runPipeline` still call
`topoOrder`, which truncates at a cycle — with cycle rejection gone, a
cycle-heavy graph that somehow reached the old runner would run only its
acyclic prefix, without looping. Acceptable (the old runner is kept for
direct/tested use only) but worth a validation *warning*, not an error.
Proposed: emit a non-fatal `cycle-present` warning entry alongside `errors`
(additive `warnings` field on `ValidationResult`).

## P2 — The firing-log record (executor still sequential)

**Goal.** The run record becomes a firing log: one entry per firing with
node, composed input, output, child session id, stop reason, timestamps
(design principle 5). The existing sequential executor writes it — a
sequential run is the special case of one firing per node — and every
existing control behavior (pause / rerun / steer / abort / restart) keeps
working through a shared per-node projection, so the UI and routes are
unchanged in behavior.

**Work items.**

- `src/types.ts` — the record (this schema is pinned here; later phases
  consume it, they do not re-shape it):

  ```ts
  interface RunFiring {
      firingId: string;        // ordered, stable ("f-001"…; start-order record)
      nodeId: string;
      seq: number;             // 1-based per-node firing number
      status: "pending" | "running" | "paused" | "done" | "aborted" | "error";
      input?: string;          // composed prompt; written once, immutable
      output?: string;
      error?: string;
      stopReason?: string;
      childSessionId?: string;
      emittedTo?: string[];    // output ports this firing emitted on (P7)
      startedAt?: string;      // ISO timestamps (design principle 5)
      settledAt?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
                               // field reserved; populated when the harness
                               // surfaces usage (run-operations §3 — out of scope)
  }

  interface RunRecord {
      /* existing fields, minus `order`, minus `coordinatorSessionId` */
      recordVersion: 2;
      maxInFlight?: number;    // default 4 (spec §1); set from POST /run
      firings: RunFiring[];
      nodes: Record<string, { parentAnchorSessionId?: string }>;
      // P4 moves the anchor id here (spec §5); until then the map stays empty.
      pausedAt?: string;       // the paused FIRING id (queue head from P5)
      dropped?: Array<{ nodeId: string; port: string; from: string }>;
                               // bound-overflow record (design principle 4)
  }
  ```

  `RunNodeState`'s status/input/output slots are gone — the log is the truth
  (principle 5); `nodes` shrinks to durable executor control state.
- `src/runs.ts` — the sequential executor writes firings; the pending-pause,
  sweep, and resurrect paths read/write the log; `readRecordFile` accepts both
  record versions (legacy read-only, per the convention above).
- New `src/projection.ts` (pure, tsdown-bundled like `graph.ts`) —
  `projectNodes(record)`: per-node status (worst-of/last-firing), latest
  output/childSessionId, per-firing runs list; consumed by the client and the
  tests.
- `src/ui/shared.ts` + `src/ui/pipeline-view.tsx` — `RunRecordLike` gains
  `firings`; node chips, the inspection modal, and `recordToResult` switch to
  the projection. `order` disappears from the record.
- `test/runs.test.ts` — existing scenarios assert the same behavior through
  `projectNodes` + the log.

**Verification gate.** Unit (marble-seeded): an A→B→C sequential run produces
exactly three `done` firings with composed inputs identical to today's
prompts; pause/rerun/steer/abort/restart scenarios stay green through the
projection. E2E: one breakpointed run in the live app — chips, inspection
modal, result modal, and continue-to-chat all behave as before.

**Risks / open details.** (1) `pausedAt` changes meaning from node id to
firing id — the docs say "queue head" without pinning the pointer type; a
firing id is required once nodes fire repeatedly. The client derives the node
via the log. (2) Principle 5 forbids parallel bookkeeping: keeping a
per-node status map would violate it, so the projection is computed, never
persisted. (3) Token usage is a reserved field only — wiring it is
run-operations work, deliberately out of scope.

## P3 — The firing kernel + NodeRunner (concurrency lands)

**Goal.** The sequential `order` walk is replaced by the firing kernel: port
queues, all-of/any-of policies, bounds, the `maxInFlight` cap, quiescence —
and nodes run concurrently as separate Harness children. The A→B,C→D graph
runs B and C at the same time; D fires once after both. Default single-port
graphs are the only supported wiring yet for *emission* (every firing emits to
its single `out`); input policies and bounds are fully live. Control surface:
unchanged semantics (breakpoints pause, abort interrupts), still via the
shared run coordinator — anchors come next.

**Work items.**

- New `src/kernel.ts` (pure — spec §6 "Kernel"): per-input-port FIFO queues
  (all edges into a port enqueue into that port's queue; fan-out copies one
  message per target port), firing rule (all-of: every wired input port holds
  an unconsumed message; any-of: at least one does), bound enforcement
  (overflow: drop + `dropped` entry, no model call), the halt gate,
  `maxInFlight` accounting, quiescence detection with the starving-node
  report, deterministic ready order (node id, then seq). Promise-based
  readiness (spec §6: "promise-per-node readiness is the idiom").
- `src/runs.ts` — `RunExecutor` internals rewritten as **NodeRunner** (one
  async task per firing: await readiness → compose via `agentInput`/`agentPrompt`
  (unchanged contract, so D still renders `## Beta` / `## Gamma` sections) →
  run one-shot or continuable epoch → emit → report terminal) and the
  **commit writer**: every record mutation flows through one chained
  `transition()` so concurrent firings cannot interleave writes (spec §6).
  The **source** is a synthetic node emitting the run input once to the wired
  roots. `startRun` accepts `maxInFlight` (record field; default 4).
- `src/index.ts` — pass `maxInFlight` from the run route body. Routes and SSE
  otherwise untouched.
- `src/ui/run-modal.tsx` — optional max-in-flight field (default 4).
- `test/runs.test.ts` — extend `makeHarness` so one-shot results settle on
  demand (deferred promises) — the marble harness needs scriptable one-shot
  interleavings, not just continuable `settle()`.

**Verification gate.** Unit (marble): fan-out/fan-in — settle B and C out of
order → D fires exactly once after the second, prompt contains both sections;
a wide fan-out respects `maxInFlight` (concurrent-start count ≤ cap); bound
overflow drops + records without firing the node; quiescence with an unfilled
all-of port ends the run with the waiting node reported. E2E: A→B,C→D with
one-shot agents — B and C chips `running` together; D strictly after both;
result modal shows D.

**Risks / open details.** (1) Any-of consumption rule is unpinned in the docs.
Proposed: an any-of firing consumes one message from every non-empty input
port (all-of's one-per-port rule with a relaxed gate) — deterministic,
composed from exactly the sources that arrived. (2) Concurrent continuable
firings still share the run coordinator here — the spec's §5 race is real but
requires two breakpointed branches admitted simultaneously; the E2E gate for
this phase deliberately uses one-shot graphs, and P4 removes the shared
handle before concurrent-breakpoint graphs are exercised. (3) Fail-fast
ordering is deliberately not in this phase: a non-completed settlement is
recorded but does not yet gate the run (P6).

## P4 — Per-node parent anchors

**Goal.** The shared per-run coordinator is gone. Each continuable node owns a
parent anchor (spec §5): created lazily, live only during that node's own
start/steer admission, disposed after — so a settlement notice can never find
a live parent (the wasted model call is unreachable by construction), and
concurrent branch admissions cannot race a shared handle (`UNAUTHORIZED`
becomes unreachable). `coordinatorSessionId` leaves the run record;
`nodes[id].parentAnchorSessionId` carries the durable address.

**Work items.**

- `src/runs.ts` — `ensureCoordinator`/`releaseCoordinator` become per-node
  (`ensureAnchor(nodeId)` / `releaseAnchor(nodeId)`); interrupt authorization
  uses the firing's node anchor id (durable header — works while disposed,
  verified against the Harness `interrupt` path); record writes move
  `coordinatorSessionId` → `nodes[id].parentAnchorSessionId`. Terminology:
  "coordinator" → "parent anchor" in code comments and user-visible strings.
- `test/runs.test.ts` — anchor lifecycle cases (spec §8): per-node creation,
  disposal after each admission, no live anchor at any settlement, two
  branches admitted concurrently never share a handle, cold-resume per node
  after restart.

**Verification gate.** Unit: the anchor cases above, plus every existing
continuable scenario green under per-node anchors. E2E: breakpoints on both B
and C in A→B,C→D — both branches park and steer independently; the DSH
session list shows no anchor session ever running a model turn (check the
anchor sessions' transcripts after the run — the spec §8 "verify unreachable"
check).

**Risks / open details.** Anchor cost: one extra session record per
continuable node per run (durable address, zero model calls) — spec-accepted.
If anchor creation fails (session agent gone), the firing fails with today's
"session agent is not live" error surface.

## P5 — Control plane: grouped pause, pending-pause queue, abort drain

**Goal.** The control plane governs firings, not nodes (spec §3–§4, design
principle 7). A settled breakpoint halts new firings run-wide while in-flight
firings finish (halt gate + quiesce — paid turns are never cancelled to
pause); several breakpoints settling while parked queue deterministically;
abort interrupts every in-flight continuable child, cancels one-shots via the
run signal, drains all settlements, then finalizes — no commit lands after
finalization. Restart rules hold under concurrency: stale `running` sweeps to
`aborted`; `paused` resurrects; a firing found `running` from before the crash
re-fires on resume with its same composed input (Rerun semantics).

**Work items.**

- `src/runs.ts` — the **ControlPlane** piece (spec §6): pause mailbox →
  pending-pause queue (settled-but-unresolved breakpoint firings, rebuilt
  deterministically in id order from the log, crash-safe); `pausedAt` = queue
  head; resume/rerun/steer target the head, releasing it surfaces the next;
  the halt gate closes on breakpoint settle; abort = interrupt set + cancel +
  drain + finalize; the inspector opens for the settling head. The inspection
  modal steers/reruns the head firing's child.
- `src/ui/pipeline-view.tsx` / `inspect-modal.tsx` — queue surface: paused
  label names the head (and queue depth); resume acts on the head.
- `test/runs.test.ts` — spec §8 control cases (below).

**Verification gate.** Unit (marble): double-breakpoint queue — two parks,
id-order release; abort mid-fan-out — both continuable children interrupted,
one-shots cancelled, drain before finalize, no post-finalize commits; pause
while a branch is in flight — in-flight output adopted and held. E2E:
breakpoint on B while C runs (C finishes and holds, resume completes);
breakpoints on both B and C (queue); abort mid-fan-out; page reload during
fan-out (record re-discovers, SSE reconnects, run continues).

**Risks / open details.** The inspection modal is currently keyed by node
(`pausedAt` node); it re-keys to the head firing — the modal shows that
firing's composed input/output. Steer remains unavailable for one-shot
(degraded) runs exactly as today.

## P6 — Fail-fast

**Goal.** One rule, no continue-on-error (spec §2): a firing that settles as
anything but `completed` records its `error` + `stopReason`, closes the halt
gate run-wide (nothing downstream of a failure starts anywhere), lets
in-flight firings finish (drain — same cost discipline as pause/abort), and
finalizes the run `state: "error"` with all completed outputs preserved. The
failure is live over SSE on the node chip and the run banner, and permanent in
the log.

**Work items.**

- `src/runs.ts` — terminal classification in NodeRunner (`completed`
  proceeds; everything else fails the run); the error path shares the halt
  gate and drain; finalization `error`.
- `src/ui/pipeline-view.tsx` — error surface on chip + banner (existing
  `state: "error"` styling, now reachable).
- `test/runs.test.ts` — spec §8 error cases.

**Verification gate.** Unit (marble): a firing settles `error`/`refusal`/
`max-tokens` → run finalizes `error`; downstream never fires; sibling
in-flight firings drain and their completed outputs are preserved; the failed
firing carries error + stopReason. E2E: force a failure (e.g. invalid model on
one agent) — chip and banner show it live; completed siblings' outputs remain
inspectable.

**Risks / open details.** The docs pin fail-fast but not whether in-flight
*siblings* drain or are abandoned at failure. Proposed (and used here):
gate + drain, mirroring pause and abort — the run is already failing, but
in-flight paid turns still settle and record. Flagging as the one deliberate
interpretation; cheap to switch to abandon-on-fail if preferred.

## P7 — Selective emission: named output ports, bindings, any-of joins

**Goal.** Conditional dispatch as base mechanics (conditional-dispatch.md): a
node emits on some output ports and not others; bindings map a structured
output field to a port deterministically (executor-side comparison, no extra
model call); unselected branches stay quiet and nothing downstream fires; any-
of joins let a downstream node proceed on whichever branch ran. Loops compose
for free (feedback/verdict ports + a bound). The canvas can author all of it.

**Work items.**

- `src/kernel.ts` — emission: evaluate bindings against the firing's
  structured result (`field == value → port`; value omitted = catch-all);
  no match → emit nowhere (recorded via `emittedTo`); fan-out copies the
  message to each edge of the selected port.
- `src/runs.ts` — NodeRunner hands the structured result (one-shot
  `result.structured`) to emission; `emittedTo` written on the firing.
- `src/ui/agent-config.tsx` — ports editor (named inputs with policy/bound,
  named outputs, bindings table) with the same class of warning the panel
  already gives when `outputSchema` meets a continuable-only constraint.
- `src/ui/pipeline-view.tsx` — edges carry port names (pickers when a node
  has multiple ports); quiet-port display is the default canvas behavior
  (nothing to render — a port with no messages is just quiet).
- `test/execution.test.ts` / `test/validate.test.ts` — binding evaluation and
  port wiring cases.

**Verification gate.** Unit (marble): mail/slack graph — the unselected
branch never fires; catch-all catches the no-match case; any-of join fires on
whichever branch ran; the Coder→Review feedback/verdict loop ends on verdict
(quiescence) and its bound drops + records overflow. E2E: draw a two-port
graph in the live app, run it, see only the selected branch run.

**Risks / open details.** Bindings need structured output, and continuable
children cannot produce it (harness limitation, already documented in
`runner.ts`). The docs don't address bindings-on-breakpointed-nodes. Proposed:
bindings evaluate only against a structured result; a node with bindings and
no structured output emits on no port (honest quiet, starved downstream
reported) — and the edit panel warns when bindings are set without
`settings.outputSchema`. Also flagging: boxes (design principle 1,
self-similar recursion) are explicitly NOT in this plan — the docs define the
model, but no spec phase sizes the box feature; it needs its own design pass.

## P8 — Marble test suite: the full verification matrix

**Goal.** The complete spec §8 unit matrix green in one suite — including the
cases earlier phase gates carried only partially — so the kernel's contract is
pinned end-to-end before the live pass. `pnpm test` is the durable,
model-free regression net for everything that follows.

**Work items.**

- `test/runs.test.ts` (+ `test/kernel.test.ts` if the pure-kernel cases
  deserve their own file) — consolidate and complete: fan-out/fan-in ordering;
  bounded cycle; bound overflow recorded; starvation report; fail-fast;
  abort drain (incl. commit-isolation assertion: the fake storage's write log
  shows no interleaved/late writes); double-breakpoint queue; `maxInFlight`;
  anchor lifecycle; determinism (same scripted run → identical firing
  structure, ready-order by id).

**Verification gate.** The full matrix green in a single `pnpm test` run,
repeatedly (the interleaving-sensitive cases must not be flaky — run the
suite several times).

**Risks / open details.** Marble tests of concurrent drains are timing-
sensitive by nature; the scripted harness's deferred settlements keep the
order deterministic (settle only when the test says so), which is the pattern
the existing `settle()` seed already uses.

## P9 — Live E2E pass + docs

**Goal.** The spec §8 live checklist passes in the running DSH Web app, and
the guides/references describe the stream executor instead of the sequential
one. The build is shippable.

**Work items.**

- E2E via /chrome-devtools (attached to the running Chrome): the full §8 live
  list — concurrent chips, strict fan-in ordering, breakpoint-while-in-flight,
  double-breakpoint queue, abort mid-fan-out, page reload during fan-out,
  steer while the other branch is in flight, anchor sessions show no
  settlement-notice turns, failure surface.
- Docs: `docs/guide/running-pipelines.md` (concurrent runs, grouped pause,
  queue, fail-fast), `docs/guide/canvas.md` (ports, policies, bounds,
  bindings), `docs/reference/graph-and-execution.md` (new schema + validation
  rules + firing-log record), `docs/index.md` rows. Note in the record
  reference that the firing log is what run-operations (reuse, history,
  per-firing token accounting) will build on — out of scope here.

**Verification gate.** Every §8 live check observed green in the app; `pnpm
sync` (typecheck + tests + build) clean; a hard-refresh run of the shipped
bundle.

**Risks / open details.** Host-side changes in any phase require the web
profile host restart, not just a refresh — easy to misread as a broken build
(`docs/guide/deployment.md`).
