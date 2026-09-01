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

## Conditional router (bindings, no extra model call)

`Router` has a structured output schema and **bindings** that map its
`action` field to one of two output ports. Only the selected branch runs;
the quiet branch never receives a message and its subtree stays idle. The
comparison is executor-side — no extra model call. The two output ports
spread over the **top** and **bottom** edges (`outputPortSides`), so the
fan-out reads at a glance — and one port per edge keeps the canvas free of
the stacked-ticks warning.

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

Rules: bindings evaluate in declaration order, first match wins; a rule with
an empty `value` is the catch-all (keep it last); no match — or no
structured result — emits on no port. Bindings need `settings.outputSchema`,
so a **breakpointed** agent (which cannot produce structured output) never
matches — the edit panel warns about both.

## Feedback loop with a bound (Coder → Review)

Cycles are ordinary wiring: `Coder` writes, `Reviewer` critiques and sends
fixes BACK to the coder's `feedback` port, or approves and emits on
`result`. The loop ends when the reviewer approves (the feedback port goes
quiet → quiescence) — and the `bound` on the coder's feedback port is the
hard stop: after 3 fix rounds the next arrival is dropped and recorded in
the run's `dropped` list. Both loop ports sit on the **bottom** edge (a
`side` on the input spec, `outputPortSides` for the output), so the return
edge routes as a bracket under the node band instead of crossing the forward wires.

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
for (wire it into the coder's any-of `in` port; one firing per arrival).
`Reviewer`'s `result` emission goes nowhere here — wire it onward to make
the approval a terminal you can read.

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
the toolbar banner and the node chip show it live, in-flight agents drain,
completed outputs stay inspectable in the record, and nothing downstream of
the failure runs. To see it deliberately: set an agent's model in the edit
panel to a name the deployment does not register and run the graph.
