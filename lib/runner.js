// dsh-agent-pipeline-canvas — minimal sequential runner (Host side).
//
// Turns a validated pipeline graph into a runnable agent pipeline by RE-USING the
// harness's own subagent service rather than inventing a new execution
// mechanism: each pipeline agent is run as a fresh, one-shot
// `subagents.start("spawn", ...)` child under a live parent Agent (the current
// session's agent). Agents run in a deterministic topological order (Kahn's
// algorithm, see topoOrder); each downstream agent's input/prompt is built with
// the execution contract in lib/execution.ts; and each completed agent's output
// is passed to its downstream dependencies. Fan-in waits for every upstream by
// construction (a node becomes ready only after all upstreams have run). The
// pipeline result is the contract's `{ outputs: { [terminalId]: output } }`.
//
// Deliberately NOT implemented: parallel execution, retries, conditions, loops,
// model/tool selection, and live execution visualization.
//
// Cancellation: the optional `signal` is honoured at two points. An ABORTED
// signal is passed to `subagents.start`, which the harness driver honours
// mid-run (the child stops, its stopReason comes back "aborted"); and the loop
// checks `signal.aborted` before starting each further node, so once aborted no
// new agent is started. The returned result carries `aborted: true` in that
// case — completed outputs stay in `outputs`, the in-flight agent is recorded
// with status "aborted", and the remaining agents are simply absent from
// `runs`.
//
// Invocation precondition (from the harness SubagentStartRequest contract): a
// live parent Agent is required. The runner resolves it from the session's agent
// (`agents.get(sessionId)`), which is the browser conversation id. This does not
// change the execution contract — it only supplies the execution context.
import { validateGraph } from "./graph.js";
import { classifyGraph, agentInput, agentPrompt, pipelineResult, topoOrder, } from "./execution.js";
/** The registered subagent provider to run each pipeline agent on (see base bundle). */
const PROVIDER = "spawn";
/** Concatenate the text blocks of a subagent result into a single string. */
function toText(output) {
    if (!Array.isArray(output))
        return "";
    return output
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}
/**
 * Run one validated pipeline graph sequentially.
 *
 * @param ctx - the plugin context exposing `agents`, `subagents`, and `logger`.
 * @param options - `{ graph, input, sessionId, signal? }`.
 *   - `graph`       the pipeline snapshot (`{ agents, connections }`).
 *   - `input`       the single pipeline-level input (given to every root agent).
 *   - `sessionId`   the live parent agent's id (browser conversation id).
 *   - `signal`      optional AbortSignal (defaults to a never-aborted signal).
 * @returns `{ ok: true, outputs, runs, order }` on success, or
 *   `{ ok: false, ... }` when the graph is invalid, the parent is unavailable,
 *   or no `spawn` provider is registered.
 */
export async function runPipeline(ctx, options) {
    const { graph, input, sessionId } = options;
    const signal = options.signal ?? new AbortController().signal;
    const validation = validateGraph(graph);
    if (!validation.ok) {
        return { ok: false, validationErrors: validation.errors };
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, error: "a live sessionId is required to run the pipeline" };
    }
    const parent = ctx.agents.get(sessionId);
    if (parent === undefined) {
        return { ok: false, error: `no live agent for session "${sessionId}"` };
    }
    if (!Array.isArray(ctx.subagents.list()) || ctx.subagents.list().indexOf(PROVIDER) === -1) {
        return { ok: false, error: `no subagent provider "${PROVIDER}" is registered` };
    }
    const classified = classifyGraph(graph);
    const agentById = new Map();
    for (const agent of graph?.agents ?? []) {
        if (agent != null && agent.id != null)
            agentById.set(String(agent.id), agent);
    }
    const order = topoOrder(graph);
    const outputsById = {};
    const runs = [];
    for (const id of order) {
        // Cancellation gate: once the caller aborts, no further agent starts.
        if (signal.aborted)
            break;
        const agent = agentById.get(id);
        const upstream = classified.upstream[id] ?? [];
        const inputs = agentInput(id, { upstream, upstreamOutputs: outputsById, pipelineInput: input });
        const prompt = agentPrompt(agent, inputs, agentById);
        const label = agent && typeof agent.name === "string" && agent.name.length > 0 ? agent.name : id;
        try {
            const run = await ctx.subagents.start(PROVIDER, {
                label,
                prompt: [{ type: "text", text: prompt }],
                parent,
                signal,
            });
            let result;
            try {
                result = await run.result;
            }
            finally {
                try {
                    await run.dispose();
                }
                catch { /* disposal failure must not mask the result */ }
            }
            const output = toText(result.output);
            outputsById[id] = output;
            runs.push({ id, label, status: result.stopReason ?? "unknown", output });
        }
        catch (error) {
            // An aborted signal can reject the start itself (the driver's
            // pre-publication abort) — record it as the abort it is, not an error.
            ctx.logger.warn(`agent-pipeline: agent "${id}" run failed: ${String(error)}`);
            runs.push({ id, label, status: signal.aborted ? "aborted" : "error", error: String(error) });
        }
    }
    const result = pipelineResult(classified.terminals, outputsById);
    return { ok: true, outputs: result.outputs, runs, order, ...(signal.aborted ? { aborted: true } : {}) };
}
//# sourceMappingURL=runner.js.map