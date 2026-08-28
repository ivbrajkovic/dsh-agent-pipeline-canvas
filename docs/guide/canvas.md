# Building pipelines on the canvas

This guide covers the editing experience: how a pipeline gets built on the
canvas, how an agent is configured, and where the graph is stored. For what
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

Both surfaces are the same component bound to the same per-repository graph —
edits in one are visible in the other.

## Nodes, ports, and connections

- Drag an **Agent** from the palette onto the canvas to add a node
  (`Agent 1`, `Agent 2`, … — ids are generated as `agent-N` and are not
  user-editable). Reposition nodes freely; click to select; the toolbar's
  **Delete** removes the selection and **Clear** empties the canvas.
- Every agent has exactly **one input port and one output port**
  (`<id>:in` / `<id>:out`). Drag from an agent's output port to another
  agent's input port to connect them; edges are directed and arrow-marked.
- Connections are flexible: an output may **fan out** to many inputs, and an
  input may **fan in** from many sources. Semantically, `A → B` means A's
  output becomes (part of) B's input. There are no explicit
  parallel/join node types — a node simply runs after all of its upstreams
  have produced output.
- Each node carries a **breakpoint dot** (top-left) and an **edit button**
  (pencil, top-right). The dot arms the
  [pause-on-output breakpoint](running-pipelines.md#breakpoints-pause-inspect-resume--rerun--steer--abort);
  the pencil opens the configuration panel.

## Validation while editing

The graph is validated **as you edit**. The toolbar shows a *Valid* /
*N issues* chip and an issue strip lists current problems:

- **cycles** — a directed cycle in the graph;
- **self-connections** and **duplicate edges**;
- connections referencing a **missing agent or port**, or mismatched
  source/target ports;
- **duplicate agent ids**, non-array `agents`/`connections`.

An absent or empty graph is valid (there is nothing to run). Validation is
**detection, not enforcement**: you can save an invalid graph, but you cannot
run it — the runner re-validates before starting and refuses an invalid
snapshot. The full rule set and error codes are documented in
[../reference/graph-and-execution.md](../reference/graph-and-execution.md).

The toolbar also has **View JSON**, which exposes the graph as structured
data — the exact shape the plugin persists and the runner consumes.

## The agent configuration panel

Click an agent's edit button to open a wide two-column card with everything
visible. A plain click on the node still just selects it.

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
  Note: a [breakpointed](running-pipelines.md#breakpoints-pause-inspect-resume--rerun--steer--abort)
  agent cannot produce structured output (harness limitation), so the schema
  is ignored for it — the panel warns when both are set.
- **Pause on output** — the breakpoint checkbox (same as the node's dot).

## Persistence

The graph persists **per repository** at
`<workspace>/.agent-pipeline/pipeline.json`:

- The view loads the file from the session's workspace root on mount and
  writes it back (debounced) after every change — add, connect, move, delete,
  clear, or edit an agent's configuration. This is what survives the view-tab
  switch that would otherwise drop component-local React state.
- The browser loads/saves through a same-origin Host route; the Host resolves
  the file under the project root and writes it **atomically** (temp file +
  rename). A relative or empty `cwd` is refused, so the file can only land
  under a real project directory.
- Because the storage path is the session's workspace directory, different
  repositories get independent pipelines.

The same storage protocol backs the run records written during execution —
see [running-pipelines.md](running-pipelines.md).
