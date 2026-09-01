# Building pipelines on the canvas

This guide covers the editing experience: how a pipeline gets built on the
canvas, how an agent is configured, how the if control makes a conditional
fork a visible node, and where the graph is stored. For what
happens when you press **Run**, see
[running-pipelines.md](running-pipelines.md); for the formal rules the editor
enforces, see [../reference/graph-and-execution.md](../reference/graph-and-execution.md).

## Where the canvas lives

The canvas is available in every session in two forms:

- A **Pipelines** view tab (beside Chat / Trajectory / Context) inside a
  session.
- A **Pipelines** button in the composer's tool row, which opens a frame-wide
  panel. The tool row renders on the blank-session hero too, so this trigger
  works even on a brand-new session, where the harness shows no view tabs at
  all. The panel binds to the CURRENT session.

Both surfaces are the same component bound to the same per-session graph —
edits in one are visible in the other.

## Nodes, ports, and connections

- Drag an **Agent** from the palette onto the canvas to add a node
  (`Agent 1`, `Agent 2`, … — ids are generated as `agent-N` and are not
  user-editable). Reposition nodes freely; click to select; the toolbar's
  **Delete** removes the selection and **Clear** empties the canvas.
- Every agent has **named input and output ports**. Undeclared, an agent has
  exactly one of each — the `in` / `out` ports (`<id>:in` / `<id>:out`).
  Declared ports (with per-port policies, bounds, sides, and output bindings)
  are edited in the configuration panel's [port
  surface](#the-port-surface--ports-policies-bounds-bindings) below. Declared
  ports each render as their own tick on a node edge — inputs default left,
  outputs right, and each port may take the top or bottom edge instead — and
  edges anchor at their port's tick, leaving and entering perpendicular to
  that edge.
- **Ports stay hidden until they are needed.** At rest a node's border is
  uninterrupted and wires land flush on it; the arrows are the wiring story.
  Hovering a node (or selecting it) fades in its ticks; dragging from an
  output tick starts a connection, the source keeps its ticks for the whole
  drag, and every other node on the canvas reveals its input ticks — the
  drop targets. The **whole node is the drop target**: the drafted wire
  snaps to the input tick nearest the cursor (the tick lights up), and
  dropping anywhere on the node connects. When a node declares several
  ports the connection editor offers **port pickers** on both ends,
  defaulted to the tick the drag started from and the input the wire snapped
  to. Edges are directed and arrow-marked.
- Connections are flexible: an output may **fan out** to many inputs, and an
  input may **fan in** from many sources. Semantically, `A → B` means A's
  output becomes (part of) B's input. There are no explicit
  parallel/join node types — a node fires when its inputs say so
  ([running-pipelines.md](running-pipelines.md#how-a-run-executes)).
- **Connections are deletable.** Hovering a wire thickens it; click it to
  select — the line and its arrowhead light brand — then press
  **Delete** / **Backspace**, use the toolbar's **Delete** button, or
  right-click the wire and pick **Delete connection**. The wire has a wide
  invisible hit zone, so a click on the line itself is enough (a node sitting
  over the wire still wins the click — the labels never do). Selection is one
  thing at a time:
  selecting a wire deselects any node, and vice versa. Deleting the wire
  that feeds an If starves the control — the validation strip reports it
  (`if-source-invalid`) until rewired.
- **Cycles are legal wiring** — the executor loops until a port goes quiet.
  A cycle shows as a non-fatal warning in the issue strip, not an error.
  Rendering keeps loops readable: put a loop's two ports on the same top or
  bottom edge and the return edge routes as an orthogonal bracket over or
  under the node band, arrowhead rising straight into the port; a leftward
  wire on horizontal edges falls back to a lane below the nodes.
- Each agent carries a **breakpoint dot** (top-left) that arms the
  [pause-on-output breakpoint](running-pipelines.md#breakpoints-grouped-pause-the-queue-resume--rerun--steer--abort).
  Nodes carry no edit button: editing an agent goes through its right-click
  context menu (**Edit agent**), an If control's through **Edit branches**.
- A run paints each agent's state **on the node**: the border, a faint
  matching tint, and a **bottom-right badge** — a pulsing dot while
  **running**, pause bars when **paused** at its breakpoint, a check when
  **done**, a stop square when the run was **aborted**, a cross on **error**
  (the tooltip names it; `pending` renders nothing). The mark is
  shape-coded, so the state never rides color alone, and everything paints
  inside the node box — ports and wires stay clear. The If control's derived
  run state is described
  [below](#the-if-control--the-fork-as-a-node).

**Node context menu.** Right-click a node to select it and open a small
per-node menu (the browser's native menu is suppressed on nodes only — the
canvas background keeps its own). An agent's menu: **Go to transcript**,
**Edit agent**,
**Arm breakpoint** / **Disarm breakpoint** (the label reflects the state),
and **Delete agent** (danger). **Go to transcript** is enabled once the node
has a child session — live, paused, and restored-last-run records all
project one; a running one-shot node gains its session only when its firing
settles, and a never-fired node shows the row disabled. Every activation
closes the menu before its action takes effect; Escape or a press outside
dismisses it. Any canvas press ends an in-flight connection drag — a
right-click included — so right-clicking a node during a drag cancels the
drag (Escape also cancels it) and then opens the menu. The transcript route
is described in
[running-pipelines.md](running-pipelines.md#results-and-the-continue-routes).
A control's menu carries **Edit branches** and **Delete control** (danger)
only — a control never fires a child session. A **connection's** menu
(right-click the wire) carries just **Delete connection** (danger); like the
per-node menus it selects its target when it opens, and it closes if the
wire vanishes before it is acted on.

## Validation while editing

The graph is validated **as you edit**. The toolbar shows a *Valid* /
*N issues* chip (plus a warning count when a cycle is present) and an issue
strip lists current problems:

- **self-connections** and **duplicate edges**;
- connections referencing a **missing agent or port**, or naming a port the
  agent does not declare (and that is not its default);
- **duplicate agent ids**, non-array `agents`/`connections`;
- malformed **port declarations** (unnamed ports, unknown policies,
  non-positive-integer bounds, duplicate port names) — see the full rule set
  in [../reference/graph-and-execution.md](../reference/graph-and-execution.md);
- malformed **control records** and broken **if wiring** — a control with no
  (or several) feeders, a control fed by a control, a feeding agent that
  keeps its own emission config, unnamed or duplicated branches, a catch-all
  that is not last, an edge naming an undeclared branch (see [the if
  control](#the-if-control--the-fork-as-a-node) below).

A **directed cycle** is reported as a *warning* (legal wiring), and the
toolbar chip gains a warning count. An absent or empty graph is valid (there
is nothing to run). Validation is **detection, not enforcement**: you can
save an invalid graph, but you cannot run it — the runner re-validates
before starting and refuses an invalid snapshot.

The toolbar also has **View JSON**, which exposes the graph as structured
data — the exact shape the plugin persists and the runner consumes.

## The agent configuration panel

Open an agent's configuration panel from its right-click context menu
(**Edit agent**) — nodes carry no edit button. A wide two-column card shows
everything visible; a plain click on the node still just selects it.

### Left column — behavior

- **Name** and **description** — the name labels the node and the
  `## <source label>` sections downstream agents see; the description is
  editorial.
- **System prompt** — real system-prompt text. The harness installs it as the
  agent's `deployment:persona` prompt section, replacing that one slot for
  this agent alone; the standard prompt (identity, policies, every tool
  explanation) is inherited untouched. See
  [../reference/system-prompt.md](../reference/system-prompt.md) for the full
  section layout and what is and isn't replaceable.
- **Instructions** — the seed of the prompt the agent is run with; the runner
  frames it together with the agent's composed input (see
  [prompt framing](../reference/graph-and-execution.md#prompt-framing)).

### Right column — settings

These are **settings, not run-time overrides**: they persist with the graph
and shape every run of the agent. Empty fields inherit defaults; present
fields are forwarded to the harness subagent start request for that agent.

- **Agent options** — provider, model, reasoning effort, max output tokens.
  Provider and Model are dropdowns served by the Host's `/options` route (the
  deployment's registered LLM routes, and one route's advertised models).
  Both default to "inherit parent"; a saved value the directory no longer
  lists stays selectable so it is never silently lost.
- **Tool filter** — allow-only or deny, comma-separated global tool names.
- **Delegation-depth cap** — absolute cap forwarded as the child's
  `maxDepth`.
- **Output schema** — an object-rooted JSON Schema. When the child returns a
  result valid against it, the validated structured output is preferred over
  the raw text (rendered as JSON) both downstream and in the result modal.
  Note: a [breakpointed](running-pipelines.md#breakpoints-grouped-pause-the-queue-resume--rerun--steer--abort)
  agent cannot produce structured output (harness limitation), so the schema
  is ignored for it — the panel warns when both are set.
- **Input ports** — named input ports, one row each: a **name**, a firing
  **policy** (`all-of` — wait for every wired source; `any-of` — fire per
  arriving message), and an optional **bound** (a delivery count — the max
  messages the port accepts this run; further arrivals are dropped and
  recorded). Undeclared (no rows) keeps the single default `in` port
  (all-of, unbounded); a declared EMPTY list means the node has no input
  ports and can never fire (surfaced as starvation at run time, not a
  validation error).
- **Output ports** — comma-separated names; undeclared keeps the single
  default `out` port (a declared empty list would emit nowhere). A firing
  emits on some of them and not on others, per the bindings below — or on
  all of them when no bindings are set.
- **Output bindings** — rules of the form `field == value → port`, evaluated
  against the firing's **structured output** (`settings.outputSchema`):
  first match wins and selects the emission port; a rule with an empty value
  is the catch-all (keep it last); no match — or no structured result at
  all — emits on no port (the quiet branch simply never runs). The panel
  warns when bindings are set without a parseable object schema, and when a
  breakpoint (which forbids structured output) meets bindings.
- **Pause on output** — the breakpoint checkbox (same as the node's dot).

### The port surface — ports, policies, bounds, bindings

The port fields make the canvas author the full stream model:

- **Policies** decide WHEN a node fires. `all-of` (the default) waits until
  every wired upstream of the port has delivered a message — fan-in joins
  for free. `any-of` fires on the first arrival — a join that proceeds on
  whichever branch ran.
- **Sides** decide WHERE on the node a port renders: left (the input
  default), right (the output default), top, or bottom — at most one port per
  edge (a second port on one edge warns and renders stacked). Geometry only,
  but it is how a loop stays readable: put the loop's two ports on the same
  vertical edge and the return line routes as a bracket over or under the
  band instead of crossing the forward wires.
- **Bounds** decide HOW OFTEN a port may receive. The bound is a delivery
  count over the whole run (the run input's seed message counts), which is
  what makes a feedback loop terminate: cap the loop's input port and the
  excess arrival is dropped and recorded in the run's `dropped` list.
- **Bindings** decide WHERE a firing's output goes. Without bindings every
  declared output port emits; with bindings the first matching rule's port
  emits and the other branches stay quiet — conditional dispatch with no
  extra model call (the comparison is executor-side, against the structured
  result the schema produced).

Short sample graphs for each pattern live in
[pipeline-samples.md](pipeline-samples.md).

## The if control — the fork as a node

A conditional can live inside the producing agent (the output ports +
bindings above) or become a visible **If control** node — the decision as
something you can see and point at:

```
                 ┌── "billing" ──→ [Billing]
[Router] ──→ ⟨ if ⟩ ── "other" ───→ [General]
```

- **Palette.** Drag an **If** from the palette onto the canvas like an agent
  (`if-1`, `if-2`, … — a separate id space from `agent-N`). The control
  renders as a flowchart decision diamond: one unnamed input tick on the
  left vertex, and one **labeled tick per branch** on the edge that branch's
  `side` picks (default right; two branches on one edge render stacked, same
  as ports). Like an agent's ticks, these hide at rest — the branch **name
  labels stay visible** (they carry the fork's semantics), the dots fade in
  on hover or selection and during a connection drag.
- **One owner.** Exactly one agent feeds the control, and the if **owns**
  that agent's entire emission surface: the agent declares no output ports
  or bindings of its own, feeds only this control, and has no other outgoing
  edges (`if-owner-conflict` otherwise). The agent keeps its **output
  schema** — the structured result shape belongs to the model call; the if
  owns only the decision. Wiring an agent that still carries ports or
  bindings into an if opens the **handoff dialog**: **Move into the if**
  folds them into branch rules (bindings first, in evaluation order; a
  trailing catch-all stays last), **Clear on the agent** drops them, and
  **Not now** lands the edge and leaves the conflict to the validation
  strip.
- **Branches.** Right-click the control → **Edit branches** (nodes carry no
  edit button; the menu is the only editor path). One row per branch —
  `name | field == value | side` — with reorder, add, and remove. Branches
  evaluate top to bottom against the feeding agent's **structured output**:
  first match wins, and the empty value is the catch-all and must stay last
  (the editor enforces both live and blocks Save on a broken shape). A
  branch tick drags to the agent that handles it like any output tick — the
  port picker opens with the branch list on every control-sourced draft, and
  the whole target node is the drop target exactly as with agents.
- **Warnings.** The control's ⚠ chip (and the same messages under the
  editor's rows) shows the non-fatal findings that name it: branches sharing
  one edge (`if-side-conflict`), and the never-fire cases — a source without
  `settings.outputSchema` or a breakpointed source can never produce the
  structured result the branches compare, so they would never fire. The
  fatal rules land in the issue strip; the full list is in
  [../reference/graph-and-execution.md](../reference/graph-and-execution.md#validation-validategraphgraph).
- **At run time** the control never fires a child session: the executor
  **lowers** it onto the feeding agent's output ports + bindings before the
  kernel starts — an if-graph runs exactly like the hand-authored bindings
  form ([the lowering
  contract](../reference/graph-and-execution.md#the-if-control-honest-graph-lowered-execution)).
  On the canvas the diamond renders no run word — its **border** carries the
  derived state of the feeding agent's latest firing: at rest until the run
  reaches the fork, **armed** brand while the firing has not reached
  emission, **fired** success green once the decision landed, **quiet**
  warning amber when the result matched no branch — nothing downstream of
  the if ran. The **branch edges** carry the decision: the chosen branch's
  edge — and its arrowhead — light success green, and the unchosen branches
  dim to dashed gray. Hovering the diamond tooltips the state and the
  chosen branches. Deleting an agent
  cascade-deletes any control it feeds and that control's edges; **Clear**
  empties controls too.

## Persistence

The graph persists **per session** at
`<workspace>/.agent-pipeline/pipelines/<sessionId>.json` — but a session
owns a file only from its first edit:

- The view loads the session's file from the session's workspace root on
  mount and writes it back (debounced) after every change — add, connect,
  move, delete, clear, or edit an agent's configuration. This is what
  survives the view-tab switch that would otherwise drop component-local
  React state.
- **Copy-on-write fork.** While a session has no file of its own, it reads
  through to the workspace's shared legacy graph
  (`.agent-pipeline/pipeline.json`) — merely opening the canvas never
  writes anything. The first edit in the session forks: that save writes
  the session's own file, and from then on the session reads and writes it,
  leaving the legacy file untouched (it keeps serving sessions that have
  not forked, and the legacy cwd-only requests). Sessions are never
  backfilled — an old session that never edits keeps the read-through
  forever.
- The browser loads/saves through a same-origin Host route; the Host
  resolves the file under the project root and writes it **atomically**
  (temp file + rename). A relative or empty `cwd` is refused and the
  session key is validated (leading alphanumeric, then alphanumerics,
  `_`, `-` — no separators — capped at 128 characters), so the file can
  only land under a real project directory.
- Because the storage path is the session's workspace directory, different
  repositories get independent pipelines — and within one repository,
  different sessions do too.
- **Known limit:** a deleted session leaves its
  `pipelines/<sessionId>.json` behind as an orphan; nothing cleans it up.

The same storage protocol backs the run records written during execution —
see [running-pipelines.md](running-pipelines.md).
