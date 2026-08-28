# Durable per-agent breakpoints

What was added to `dsh-agent-pipeline-canvas`, in one page.

## The feature

Every agent on the canvas has a **Pause on output** breakpoint (the dot in the
node's top-left corner, or the checkbox in the edit panel). When a run reaches a
breakpointed agent, the agent executes, its output settles, and the **whole
pipeline pauses before any downstream agent starts**. An inspection modal shows
the agent's composed input (fixed for the run) and its output, and offers:

| Action  | What it does                                                                              |
|---------|-------------------------------------------------------------------------------------------|
| Resume  | Continue with the recorded output — to the next breakpoint, or run finalization.          |
| Rerun   | A fresh child (new session, old transcript kept) started with the **verbatim** original input; back to paused with the new output. |
| Steer   | Send feedback to the **same** agent — it keeps its transcript and answers again; repeat indefinitely. The run stays paused. |
| Abort   | Stop the run: an in-flight turn is interrupted; completed outputs are preserved.           |

Multiple breakpoints pause independently, in topological order. A breakpoint on
a terminal agent pauses before finalization. `Steer` requires non-empty text.

## How it works

- `POST /dsh-agent-pipeline/run` no longer blocks: it validates the snapshot and
  starts a **run executor** in the Host process, returning `{ runId }`. One run
  is active per workspace (a second start gets `409 { activeRunId }`).
- The run's whole state persists at `<cwd>/.agent-pipeline/runs/<runId>.json`
  (atomic writes). The browser follows it over **SSE**
  (`/run/events`) and re-discovers an active run after a page reload via the
  `run` field of `GET /dsh-agent-pipeline?cwd=…`. **Runs outlive the tab.**
- Non-breakpointed agents run exactly as before (one-shot `spawn` children of
  the session agent). Breakpointed agents run as **continuable children** under
  a disposable per-run **coordinator** agent (hidden, `origin: "subagent"`,
  `delegationDepth: 0`) so the harness's settlement notices never wake the
  user's chat. The coordinator is only live inside control operations.
- **Steering** is `subagents.followup` to the same durable child — it
  cold-resumes from the persisted session, so it works **across profile
  restarts**. Each steering epoch's answer is adopted directly (harness
  epoch-relative output). Settlements arrive via the `subagent/end` event.
- **Durability:** a paused run survives page reloads and profile restarts.
  On the next workspace load, a stale `running` record is swept to `aborted`
  (outputs intact); a `paused` record is resurrected fully controllable.
- **Limitation:** continuable children cannot produce structured output (a
  harness constraint), so a breakpointed agent ignores `settings.outputSchema`
  — the edit panel warns when both are set. Other settings (model, tools,
  depth, persona) carry through. Canvas edits during a run affect only the
  next run (the executor works on an immutable snapshot).
- **Degradation:** without the continuable runtime, breakpointed agents run
  one-shot and still pause; steering is rejected, rerun/resume still work.

## Where the code lives

- `src/runs.ts` — run registry: executor loop + control mailbox, record
  persistence, coordinator lifecycle, restart sweep, single-active-run rule.
- `src/runner.ts` — `runOneAgent` (one-shot) and the continuable/steer primitives.
- `src/index.ts` — routes: `POST /run`, `GET /run`, `GET /run/events` (SSE),
  `POST /control`, plus the `run` field on the pipeline GET.
- `src/ui/` — breakpoint toggle + live node states (`pipeline-view`), the
  inspection modal (`inspect-modal.tsx`), the config checkbox (`agent-config`).
- `test/runs.test.ts` — 67 scripted checks (pause ordering, rerun/steer/abort,
  restart, 409, coordinator disposal, degradation); full suite: 161 checks.

## Verified end-to-end (live app, 3-agent pipeline, breakpoint on agent 2)

Pause + inspection → rerun (same input, fresh child, new output) → steer twice
to the same child (the child's answer proved transcript continuation) → resume
through agent 3 → correct result modal. A second run verified abort
preservation, **both** breakpoints pausing in sequence, the terminal-agent
breakpoint, page-reload discovery, and a paused run surviving a profile
restart with steering still reaching the same child.
