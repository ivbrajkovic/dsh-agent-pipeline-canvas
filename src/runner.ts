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
// cancellation, model/tool selection, and live execution visualization.
//
// Invocation precondition (from the harness SubagentStartRequest contract): a
// live parent Agent is required. The runner resolves it from the session's agent
// (`agents.get(sessionId)`), which is the browser conversation id. This does not
// change the execution contract — it only supplies the execution context.

import { validateGraph } from "./graph.ts";
import {
	classifyGraph,
	agentInput,
	agentPrompt,
	pipelineResult,
	topoOrder,
} from "./execution.ts";
import type {
	Agent,
	PipelineGraph,
	PipelineRunRequest,
	PipelineRunResult,
} from "./types.ts";

/** The registered subagent provider to run each pipeline agent on (see base bundle). */
const PROVIDER = "spawn";

// ---- Minimal, structural views of the harness services this runner touches ----
// These are intentionally NOT the full @deepseek-ai/cordis service types: the
// plugin is a standalone local package with zero runtime deps, so it names only
// the fields it calls. The real services satisfy the same shapes structurally.

interface SubagentResult {
	output?: unknown;
	stopReason?: string;
}

interface SubagentRun {
	result: Promise<SubagentResult>;
	dispose(): Promise<void> | void;
}

interface SubagentStartRequest {
	label?: string;
	prompt: unknown[];
	parent: unknown;
	signal?: AbortSignal;
}

interface SubagentsService {
	list(): string[];
	start(provider: string, req: SubagentStartRequest): SubagentRun;
}

interface AgentsService {
	get(sessionId: string): unknown | undefined;
}

interface Logger {
	warn(...args: unknown[]): void;
}

/** The slice of the plugin context the runner needs. */
export interface RunnerContext {
	agents: AgentsService;
	subagents: SubagentsService;
	logger: Logger;
}

/** Concatenate the text blocks of a subagent result into a single string. */
function toText(output: unknown): string {
	if (!Array.isArray(output)) return "";
	return output
		.filter((block) => block && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => (block as { text: string }).text)
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
export async function runPipeline(ctx: RunnerContext, options: PipelineRunRequest): Promise<PipelineRunResult> {
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
	const agentById = new Map<string, Agent>();
	for (const agent of (graph as PipelineGraph | null)?.agents ?? []) {
		if (agent != null && agent.id != null) agentById.set(String(agent.id), agent);
	}

	const order = topoOrder(graph);
	const outputsById: Record<string, unknown> = {};
	const runs: Array<{ id: string; label: string; status: string; output?: string; error?: string }> = [];

	for (const id of order) {
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
			let result: SubagentResult;
			try {
				result = await run.result;
			} finally {
				try { await run.dispose(); } catch { /* disposal failure must not mask the result */ }
			}
			const output = toText(result.output);
			outputsById[id] = output;
			runs.push({ id, label, status: result.stopReason ?? "unknown", output });
		} catch (error) {
			ctx.logger.warn(`agent-pipeline: agent "${id}" run failed: ${String(error)}`);
			runs.push({ id, label, status: "error", error: String(error) });
		}
	}

	const result = pipelineResult(classified.terminals, outputsById);
	return { ok: true, outputs: result.outputs, runs, order };
}
