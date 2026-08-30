# Design principles

The pipeline is a **stream graph**: nodes wired together through ports,
executing as data arrives. These rules define the model. Every feature argues
against them, not around them.

Prior art this model stands on: **Kahn process networks** (deterministic
dataflow over FIFO channels — cycles are legal, firing is data-driven,
quiescence is termination) and **ReactiveX** (the operator vocabulary:
combine, merge, take, completion). We adopt the vocabulary, not the library:
the kernel is ours — small, dependency-free, and **data-declarable**. Every
primitive (a port policy, a bound, a binding) is expressible in the persisted
graph; nothing that cannot be drawn on the canvas is part of the model. What
neither prior art provides — durable, resumable, inspectable, pausable
streams whose transforms cost money — is what this executor adds.

## The model, in one paragraph

Everything is a **node**. A node has named **input and output ports**; a port
carries **messages** — one agent run's output per message. A node **fires**
whenever each input port holds an unconsumed message: ports are **all-of** by
default, or **any-of**. Firing composes the agent's input from the arriving
messages, runs the agent once, and emits to output ports **selectively** — a
port that receives nothing stays quiet. A node may fire many times; a graph
where every input arrives exactly once is the special case where each node
fires once. A run's input is itself a node (the **source**); the run's result
is whatever streams reach terminal outputs; and a run ends at **quiescence** —
nothing in flight, nothing queued.

## 1. One model, self-similar all the way down

A **box** is a graph presented as a node: the same ports, the same firing
rules, recursively. Boxes contain boxes. There are no constructs that exist
only inside boxes or only on the top canvas — if it is legal anywhere, it is
legal everywhere, and it means the same thing everywhere.

## 2. The wiring is the truth

The canvas shows the real dataflow. A loop is a cycle in the wiring — legal
because firing is data-driven — and it ends the honest way: a port goes quiet.
The reviewer that emits a verdict instead of feedback *is* the loop control;
the canvas draws exactly that. No sugar, no hidden expansion, no arrow that
means something other than what it draws.

## 3. Fail fast, surface everything

A firing that does not settle as `completed` fails the run. Nothing downstream
starts on a broken or partial input; no output is silently replaced by an
empty string. Quiescence with starvation is equally honest: an all-of port
that never fills leaves its node visibly waiting, and a run that ends quiet
reports every waiting node. Failures and starvation are visible immediately
and recorded permanently — never routed around in silence.

## 4. Cost discipline — no wasted model calls

LLM calls are the scarce resource; the model treats them that way.

- Firing is unbounded by default, so **bounds are core**: a port may declare a
  maximum delivery count; further messages are dropped and recorded. A loop
  budget is a port bound, not a loop feature.
- A paused run halts new firings but **lets in-flight turns finish** —
  cancelling paid work to pause would throw that money away.
- **Parent anchors** (the hidden parent session of a continuable child) are
  never live when a child settles: settlement notices find no parent and are
  dropped instead of waking one with a model turn. An anchor is an
  authorization address, never a worker; it never runs a model turn.
- Visibility follows the same principle: every firing's token usage is
  recorded, so spend traces to the firing that spent it.

## 5. The record is a firing log

Every firing is an entry — node, composed input, output, child session id,
stop reason, cost, timestamps. A node that fired three times has three
entries; there is no single per-node slot to overwrite. The record is the
durable truth: it is how breakpoints, resume, steering, restart survival, and
inspection all work — state is a query over saved history, never a parallel
bookkeeping system.

## 6. Node-scoped behavior is a node field

Behavior that belongs to one agent is a field on the agent, not a new edge
kind or graph mechanism. The breakpoint is the precedent: a boolean that
shapes how the executor runs that node's firings. If a feature's scope is
"this node," it is a node field.

## 7. The control plane serves firings

Pause, resume, rerun, steer, and abort act on firings: a pause is a **halt
gate** (no new firings; in-flight firings finish), steer reaches the paused
firing's same child, abort drains every in-flight firing before finalizing.
The control rules do not depend on graph shape — the same controls govern a
straight line, a wide fan-out, or a cycle.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Node** | One step on the canvas: an agent — or a box (a graph presented as a node). |
| **Port** | A named input or output of a node; carries messages. Input policy: `all-of` (default) or `any-of`; optional delivery bound. |
| **Message / stream** | One agent run's output on a port / the sequence of messages a port carries. |
| **Firing** | One execution of a node: consume one message per input port, run the agent, emit selectively to output ports. |
| **Quiescence** | The run's end state: nothing in flight, nothing queued. Waiting nodes are reported. |
| **Source** | The synthetic node that emits the run's input once. |
| **Selective emission** | A node emitting on some output ports and not others — conditionality as base mechanics. |
| **Box** | A graph presented as a node; same rules, recursive. |
| **Parent anchor** | The hidden parent session of a continuable child — an authorization address, never a worker (the pre-executor "coordinator", renamed and made per-node). |
| **Halt gate** | The pause mechanism: stop new firings, let in-flight firings finish. |
