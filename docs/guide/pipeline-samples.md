# Pipeline samples

Short, copy-pasteable graphs for the common patterns. Save each into
`.agent-pipeline/pipeline.json` in the workspace — the canvas picks it up on
the next mount in any session that has not forked its own graph yet (reload
the tab if the view is already open; a forked session reads only its
`pipelines/<sessionId>.json` — see [canvas.md](canvas.md#persistence)). Agents here
use minimal instructions so runs are cheap and predictable — swap in your
own prompts. Firing rules and record shape:
[../reference/graph-and-execution.md](../reference/graph-and-execution.md);
editing: [canvas.md](canvas.md); run behavior:
[running-pipelines.md](running-pipelines.md).

## A sequential chain (the default shape)

No port declarations — one `in`, one `out` per agent. `A` runs, then `B`,
then `C`; `C`'s prompt carries `## A` and `## B` sections.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Topic", "description": "", "instructions": "Name one interesting topic in one short phrase.", "x": 60,  "y": 80, "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Outline", "description": "", "instructions": "Write a three-bullet outline for the topic you receive.", "x": 300, "y": 80, "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "Polish", "description": "", "instructions": "Rewrite the outline you receive as one polished paragraph.", "x": 540, "y": 80, "input": "agent-3:in", "output": "agent-3:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:out", "targetPort": "agent-2:in" },
    { "id": "c2", "source": "agent-2", "target": "agent-3", "sourcePort": "agent-2:out", "targetPort": "agent-3:in" }
  ]
}
```

## Fan-out / fan-in (concurrent branches, one join)

`Seed` completes once, `Beta` and `Gamma` start **at the same time** as
separate subagent children, and `Delta` fires exactly once after both — its
prompt is composed from both outputs (`## Beta` + `## Gamma`). The fan-in is
just the default all-of port: no join node exists.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Seed",   "description": "", "instructions": "Output exactly: SEED-OK",  "x": 60,  "y": 80,  "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Beta",   "description": "", "instructions": "Summarize the input in five words.", "x": 300, "y": 20,  "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "Gamma",  "description": "", "instructions": "List three questions the input raises.", "x": 300, "y": 160, "input": "agent-3:in", "output": "agent-3:out" },
    { "id": "agent-4", "name": "Delta",  "description": "", "instructions": "Merge the sections you receive into one short brief.", "x": 540, "y": 80, "input": "agent-4:in", "output": "agent-4:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:out", "targetPort": "agent-2:in" },
    { "id": "c2", "source": "agent-1", "target": "agent-3", "sourcePort": "agent-1:out", "targetPort": "agent-3:in" },
    { "id": "c3", "source": "agent-2", "target": "agent-4", "sourcePort": "agent-2:out", "targetPort": "agent-4:in" },
    { "id": "c4", "source": "agent-3", "target": "agent-4", "sourcePort": "agent-3:out", "targetPort": "agent-4:in" }
  ]
}
```

The run dialog's **Max agents in flight** caps how many of the ready
branches start at once (default 4) — lower it to 1 and the same graph runs
sequentially.

## Any-of join (proceed on whichever branch ran)

`Fast` and `Thorough` are two alternative producers; `Sink` declares its
input port `any-of`, so it fires on the FIRST arrival instead of waiting for
both. Deliveries that arrive while `Sink` runs are consumed by its NEXT
firing — a node may fire many times.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Fast",     "description": "", "instructions": "Answer in one short sentence.", "x": 60,  "y": 20,  "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Thorough", "description": "", "instructions": "Answer with a detailed paragraph.", "x": 60,  "y": 160, "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "Sink",     "description": "", "instructions": "Forward the answer you receive verbatim.",
      "inputPorts": [ { "name": "in", "policy": "any-of" } ],
      "x": 320, "y": 80, "input": "agent-3:in", "output": "agent-3:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-3", "sourcePort": "agent-1:out", "targetPort": "agent-3:in" },
    { "id": "c2", "source": "agent-2", "target": "agent-3", "sourcePort": "agent-2:out", "targetPort": "agent-3:in" }
  ]
}
```

Both producers here are roots — each receives the run input, so both fire
once. In a bigger graph you would wire them behind a router (next sample) so
only one runs.

## Conditional router (the if control)

`Router` feeds an **if control** that owns the decision: two branches
(`billing`, `other`) test the router's structured `action` field — first
match wins. Only the selected branch runs; the quiet branch never receives a
message and its subtree stays idle. The comparison is executor-side — no
extra model call. The router declares only its **output schema**; the
branches spread over the control's **top** and **bottom** edges so the
fan-out reads at a glance.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Router", "description": "", "instructions": "Decide: does the input ask about billing or something else? Report {\"action\": \"billing\"} or {\"action\": \"other\"} via the structured_output tool.",
      "settings": { "agentOptions": { "model": "deepseek-v4-flash" },
                    "outputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["billing", "other"] } }, "required": ["action"] } },
      "x": 60, "y": 88, "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Billing", "description": "", "instructions": "Answer the billing question in one sentence.", "x": 400, "y": 20,  "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "General", "description": "", "instructions": "Answer the question in one sentence.",       "x": 400, "y": 160, "input": "agent-3:in", "output": "agent-3:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "if-1", "sourcePort": "agent-1:out" },
    { "id": "c2", "source": "if-1", "target": "agent-2", "sourcePort": "if-1:billing", "targetPort": "agent-2:in" },
    { "id": "c3", "source": "if-1", "target": "agent-3", "sourcePort": "if-1:other",   "targetPort": "agent-3:in" }
  ],
  "controls": [
    { "id": "if-1", "kind": "if",
      "branches": [
        { "name": "billing", "field": "action", "value": "billing", "side": "top" },
        { "name": "other",   "field": "action", "value": "other",   "side": "bottom" }
      ],
      "x": 220, "y": 76 }
  ]
}
```

Notes on the shape: the control-targeted connection carries **no
`targetPort`** (an if takes a single unnamed input), each control-sourced
connection names its **branch** as `sourcePort`, and the feeding agent
declares no `outputPorts`/`bindings` of its own — the if owns its whole
emission surface (`if-owner-conflict` otherwise). On the canvas you author
this with the palette's **If** brick, the branch editor (right-click the
control → **Edit branches**), and branch-tick drags — see
[canvas.md](canvas.md#the-if-control--the-fork-as-a-node). At run time the
control **lowers** onto the router's output ports + bindings before the
kernel starts, so this graph executes exactly like the hand-authored form
below — the run record names agents only.

Run it: a billing question fires `Billing` only (the diamond's border lights
green and the billing edge — line and arrowhead — lights with it, the other
branch dimming to dashed gray); anything else flips the
highlight to `other`; a value that matches no branch with no catch-all
present starves the downstream nodes — the result modal lists them as
pending, and the host log names the waiting nodes.

### The hand-authored twin (bindings on the agent)

The same graph without a control — the decision lives on the agent as output
ports + bindings, edited in the agent panel's port surface. Both forms run
identically: the if control is an authoring upgrade over the same mechanism,
and one port per edge (`outputPortSides`) keeps the canvas free of the
stacked-ticks warning.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Router", "description": "", "instructions": "Decide: does the input ask about billing or something else? Report {\"action\": \"billing\"} or {\"action\": \"other\"} via the structured_output tool.",
      "outputPorts": [ "billing", "other" ],
      "outputPortSides": { "billing": "top", "other": "bottom" },
      "bindings": [
        { "field": "action", "port": "billing", "value": "billing" },
        { "field": "action", "port": "other",   "value": "other" }
      ],
      "settings": { "agentOptions": { "model": "deepseek-v4-flash" },
                    "outputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["billing", "other"] } }, "required": ["action"] } },
      "x": 60, "y": 80, "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Billing", "description": "", "instructions": "Answer the billing question in one sentence.", "x": 320, "y": 20,  "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "General", "description": "", "instructions": "Answer the question in one sentence.",       "x": 320, "y": 160, "input": "agent-3:in", "output": "agent-3:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:billing", "targetPort": "agent-2:in" },
    { "id": "c2", "source": "agent-1", "target": "agent-3", "sourcePort": "agent-1:other",   "targetPort": "agent-3:in" }
  ]
}
```

Rules (both forms): branches/bindings evaluate in declaration order, first
match wins; an empty `value` is the catch-all (keep it last); no match — or
no structured result — emits on no port. Both need
`settings.outputSchema`, so a **breakpointed** agent (which cannot produce
structured output) never matches — the edit panel and the control's ⚠ chip
warn about both.

## The Reviewer loop (the if-authored form)

The flowchart loop, drawn: `Task` seeds the work, `Coder` writes, `Reviewer`
critiques, and the **if control** at the loop tail decides — `verdict ==
approve → done` (onward to `Polish`), `$count >= 3 → exhausted` (the
budget: the reviewer's firing sequence for this firing, 1-based, is the
iteration number), and the catch-all `retry` wires **backward to the
Coder**. On the canvas you author it exactly like that: drag the `retry`
branch tick back onto the Coder, and the **backward-edge assist** flips the
Coder's entry port to `any-of` for you (the drop that closes the cycle — the
flip is a real port edit you can see in the agent panel and View JSON;
here it is pre-declared in the JSON). The `$count >= 3` row ahead of the
catch-all is the loop's guard — without it, `cycle-unguarded` refuses the
run. `$count` tests the firing, not the structured result, so it works even
where content rows would not.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Task", "description": "", "instructions": "Restate the run input as a one-sentence coding task.",
      "x": 40, "y": 80, "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Coder", "description": "", "instructions": "Write the requested function. Address any review feedback you receive, then output the final code.",
      "inputPorts": [ { "name": "in", "policy": "any-of" } ],
      "x": 240, "y": 80, "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "Reviewer", "description": "", "instructions": "Review the code you receive. If it needs changes, report {\"verdict\": \"fix\"}; if it is good, report {\"verdict\": \"approve\"}.",
      "settings": { "outputSchema": { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["fix", "approve"] } }, "required": ["verdict"] } },
      "x": 440, "y": 80, "input": "agent-3:in", "output": "agent-3:out" },
    { "id": "agent-4", "name": "Polish", "description": "", "instructions": "Polish the approved code and add one usage example.",
      "x": 680, "y": 20, "input": "agent-4:in", "output": "agent-4:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:out", "targetPort": "agent-2:in" },
    { "id": "c2", "source": "agent-2", "target": "agent-3", "sourcePort": "agent-2:out", "targetPort": "agent-3:in" },
    { "id": "c3", "source": "agent-3", "target": "if-1", "sourcePort": "agent-3:out" },
    { "id": "c4", "source": "if-1", "target": "agent-2", "sourcePort": "if-1:retry", "targetPort": "agent-2:in" },
    { "id": "c5", "source": "if-1", "target": "agent-4", "sourcePort": "if-1:done", "targetPort": "agent-4:in" }
  ],
  "controls": [
    { "id": "if-1", "kind": "if",
      "branches": [
        { "name": "done",      "field": "verdict", "value": "approve", "side": "top" },
        { "name": "exhausted", "field": "$count",  "value": "3", "op": ">=", "side": "bottom" },
        { "name": "retry" }
      ],
      "x": 560, "y": 76 }
  ]
}
```

Run it: each pass lights the `retry` edge and the diamond counts `iter 1/3`,
`iter 2/3`… An approval on any iteration exits through `done` — `Polish`
runs and the loop is over. A reviewer that never approves exhausts at 3:
iteration 3 matches `$count >= 3` ahead of the catch-all, `emittedTo` reads
`["exhausted"]`, the run finalizes `completed`, and `Polish` never started.
The control-targeted connection (`c3`) carries **no `targetPort`** and each
branch edge names its branch as `sourcePort`; the run record names agents
only (the if lowers onto the Reviewer's ports + bindings). The `in` port on
the Coder is `any-of` because it receives the seed AND the loop-back — under
the default `all-of` the consumed seed would starve the body
(`cycle-entry-all-of` warns; the assist prevents).

### The ports+bindings twin (the power path)

The same loop without a control — the decision lives on the Reviewer as
output ports + bindings, and the budget is a `bound` on the Coder's
`feedback` port instead of a `$count` row. Both forms run identically; the
hand-authored shape is the power path for graphs that skip the if
(`bound: 3` drops the fourth arrival and records it in the run's `dropped`
list). Both loop ports sit on the **bottom** edge (a `side` on the input
spec, `outputPortSides` for the output), so the return edge routes as a
bracket under the node band instead of crossing the forward wires.

```json
{
  "agents": [
    { "id": "agent-1", "name": "Task", "description": "", "instructions": "Restate the run input as a one-sentence coding task.",
      "x": 40, "y": 80, "input": "agent-1:in", "output": "agent-1:out" },
    { "id": "agent-2", "name": "Coder", "description": "", "instructions": "Write the requested function. Address any review feedback you receive, then output the final code.",
      "inputPorts": [ { "name": "in", "policy": "any-of" }, { "name": "feedback", "policy": "any-of", "side": "bottom", "bound": 3 } ],
      "x": 260, "y": 80, "input": "agent-2:in", "output": "agent-2:out" },
    { "id": "agent-3", "name": "Reviewer", "description": "", "instructions": "Review the code you receive. If it needs changes, report {\"verdict\": \"fix\"}; if it is good, report {\"verdict\": \"approve\"}.",
      "outputPorts": [ "feedback", "result" ],
      "outputPortSides": { "feedback": "bottom" },
      "bindings": [
        { "field": "verdict", "port": "feedback", "value": "fix" },
        { "field": "verdict", "port": "result",   "value": "approve" }
      ],
      "settings": { "outputSchema": { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["fix", "approve"] } }, "required": ["verdict"] } },
      "x": 500, "y": 80, "input": "agent-3:in", "output": "agent-3:out" }
  ],
  "connections": [
    { "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:out",      "targetPort": "agent-2:in" },
    { "id": "c2", "source": "agent-2", "target": "agent-3", "sourcePort": "agent-2:out",      "targetPort": "agent-3:in" },
    { "id": "c3", "source": "agent-3", "target": "agent-2", "sourcePort": "agent-3:feedback", "targetPort": "agent-2:feedback" }
  ]
}
```

A loop never self-starts: the synthetic run input feeds only **edge-less**
nodes, so the cycle needs an outside seed — that is what the `Task` root is
for. In the if-authored form the seed enters the Coder's `any-of` `in` port;
in the twin, the same port (the bound caps only `feedback`). The approval
escape goes onward to `Polish` in the if-authored form; in the twin
`Reviewer`'s `result` stays unwired — a quiet terminal you can still read
in `emittedTo` (wire it onward to make the approval feed a downstream
agent).

## Breakpoints: inspect, steer, queue

Any agent's breakpoint dot arms a pause-on-output breakpoint. When it
settles, the whole parallel section parks: in-flight agents finish and hold
their outputs, nothing new starts, and the inspection modal opens. From
there: **Resume** (continue), **Rerun** (fresh child, same verbatim input),
**Steer** (feedback to the SAME child — it keeps its transcript), **Abort**
(interrupt everything, keep completed outputs). Arm breakpoints on both
branches of the fan-out sample and both park: the banner reads *Paused at
&lt;agent&gt; +1 queued*, and each Resume releases the current head and
surfaces the next.

Steering is the cheapest way to course-correct mid-run: park at the
breakpoint, type the correction, press **Steer** — the agent's revised
answer is adopted and flows downstream on Resume.

## Failing fast

There is no continue-on-error: a firing that settles as anything but
`completed` (error, refusal, max-tokens) ends the run in `state: "error"` —
the toolbar banner and the failing node's red border and ✕ badge show it
live, in-flight agents drain,
completed outputs stay inspectable in the record, and nothing downstream of
the failure runs. To see it deliberately: set an agent's model in the edit
panel to a name the deployment does not register and run the graph.
