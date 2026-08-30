// dsh-agent-pipeline-canvas — sequential runner + per-agent primitives (Host side).
//
// The runner turns a validated pipeline graph into a runnable agent pipeline by
// RE-USING the harness's own subagent service rather than inventing a new
// execution mechanism: each pipeline agent is run as a fresh child under a live
// parent Agent (the current session's agent). Agents run in a deterministic
// topological order (Kahn's algorithm, see topoOrder); each downstream agent's
// input/prompt is built with the execution contract in lib/execution.ts; and
// each completed agent's output is passed to its downstream dependencies.
// Fan-in waits for every upstream by construction (a node becomes ready only
// after all upstreams have run). The pipeline result is the contract's
// `{ outputs: { [terminalId]: output } }`.
//
// Two per-agent primitives live here, shared by the blocking `runPipeline`
// executor and the durable run registry (lib/runs.ts):
//
//   - runOneAgent: the ONE-SHOT primitive. `subagents.start("spawn", ...)`,
//     awaits the run's result, prefers a validated structured value, disposes.
//     Non-breakpointed pipeline agents keep exactly this path.
//   - startContinuableAgent: the CONTINUABLE primitive behind breakpoints.
//     `subagents.startContinuable(...)` establishes a durable child that can be
//     steered later (`subagents.followup`) and survives profile restarts
//     (cold resume from its persisted session). It resolves on inbox
//     acceptance — the caller learns the child id immediately and awaits
//     settlement separately, via `subagent/end` events (subscribeRunEnd).
//
// Per-agent settings: an agent entry may carry an optional `settings` object
// ({ maxDepth, agentOptions, toolFilter, outputSchema }, see types.ts) —
// authored in the client's configuration panel and persisted on the agent.
// They are settings, not run-time overrides: saved with the graph, they shape
// every run of that agent. Each present field is forwarded as the
// corresponding subagent request field (the spawn provider supports all of
// them), so a pipeline agent can run on a specific model, with restricted
// tools, a delegation-depth cap, or a structured outputSchema; an absent field
// inherits the default. When a one-shot child returns a validated structured
// value it is preferred over the raw text output and rendered as JSON — that
// rendered string is what flows downstream and into the run record. The system
// prompt is forwarded from the agent's first-class `systemPrompt` field
// (mapped to the harness request's `persona` field).
//
// Continuable children CANNOT produce structured output: the harness's
// `ContinuableStartSpec.request` structurally omits `outputSchema`. A
// breakpointed agent therefore ignores `settings.outputSchema` (the edit panel
// warns when both are set); every other setting carries to the continuable
// request unchanged.
//
// Child sessions: one-shot runs publish the child session id (`run.id` — for a
// local run it IS the child's session id); continuable starts return the
// durable child id directly. Both are recorded per agent as `childSessionId`
// so the client can open the agent's full transcript.
//
// Invocation precondition (from the harness SubagentStartRequest contract): a
// live parent Agent is required. `runPipeline` resolves it from the session's
// agent (`agents.get(sessionId)`), which is the browser conversation id.

import { validateGraph } from "./graph.ts";
import {
	classifyGraph,
	agentInput,
	agentPrompt,
	pipelineResult,
	renderValue,
	topoOrder,
} from "./execution.ts";
import type {
	Agent,
	AgentExecutionInput,
	AgentSettings,
	PipelineGraph,
	PipelineRunRequest,
	PipelineRunResult,
} from "./types.ts";

/** The registered subagent provider to run each pipeline agent on (see base bundle). */
export const PROVIDER = "spawn";

// ---- Minimal, structural views of the harness services this runner touches ----
// These are intentionally NOT the full @deepseek-ai/cordis service types: the
// plugin is a standalone local package with zero runtime deps, so it names only
// the fields it calls. The real services satisfy the same shapes structurally.

interface SubagentResult {
	output?: unknown;
	structured?: unknown;
	stopReason?: string;
}

interface SubagentRun {
	/** The published child session id (a local run's id IS the child session id). */
	id?: string;
	result: Promise<SubagentResult>;
	dispose(): Promise<void> | void;
}

interface SubagentStartRequest {
	label?: string;
	prompt: unknown[];
	parent: unknown;
	signal?: AbortSignal;
	agentOptions?: AgentSettings["agentOptions"];
	outputSchema?: unknown;
	maxDepth?: number;
	toolFilter?: AgentSettings["toolFilter"];
	persona?: string;
}

/**
 * Structural view of the harness continuable start spec: the manager reserves
 * the durable child id and composes the child; `request` structurally omits
 * `label`, `signal` (spec-level), and `outputSchema` (unsupported — continuable
 * children cannot produce structured output).
 */
export interface ContinuableStartSpecLike {
	provider: string;
	label: string;
	childId?: string;
	request: {
		prompt: unknown[];
		parent: unknown;
		agentOptions?: AgentSettings["agentOptions"];
		maxDepth?: number;
		toolFilter?: AgentSettings["toolFilter"];
		persona?: string;
	};
	signal?: AbortSignal;
}

/** Structural view of a `subagent/end` payload (`SubagentRunEndInfo`). */
export interface SubagentRunEndInfoLike {
	runId?: string;
	provider?: string;
	/** The child session id this settlement belongs to. */
	id?: string;
	stopReason?: string;
	/**
	 * The epoch's final assistant output. For a continuable epoch this is
	 * EPOCH-RELATIVE (sliced to the turns the epoch itself produced), so a
	 * steering epoch reports only the new answer — adopt it directly.
	 */
	lastAssistantMessage?: unknown;
}

interface SubagentsService {
	list(): string[];
	start(provider: string, req: SubagentStartRequest): SubagentRun;
	/** Present when the deployment supports continuable (steerable) children. */
	startContinuable?(spec: ContinuableStartSpecLike): Promise<{ childId?: string; messageId?: unknown }>;
	/** Deliver a follow-up turn to a continuable child (cold-resumes it if needed). */
	followup?(parent: unknown, childId: string, content: unknown[], options: { source?: unknown; signal?: AbortSignal }): Promise<unknown>;
	/** Interrupt a live continuable child's current turn (absent target = no-op). */
	interrupt?(childId: string, authority: { kind: "user"; parentSessionId: string }): void;
}

interface AgentsService {
	get(sessionId: string): unknown | undefined;
}

interface Logger {
	warn(...args: unknown[]): void;
}

/**
 * The slice of the plugin context the runner needs. `subscribeRunEnd` is the
 * injectable settlement seam: production wires it to `ctx.on("subagent/end")`;
 * tests supply a fake emitter. It must return a disposer and callers must
 * register the listener BEFORE starting/steering children.
 */
export interface RunnerContext {
	agents: AgentsService;
	subagents: SubagentsService;
	logger: Logger;
	subscribeRunEnd?(fn: (info: SubagentRunEndInfoLike) => void): () => void;
}

/** Whether this deployment can run breakpointed agents as continuable children. */
export function continuableSupported(ctx: RunnerContext): boolean {
	return typeof ctx.subagents.startContinuable === "function" && typeof ctx.subscribeRunEnd === "function";
}

/** Concatenate the text blocks of a subagent result into a single string. */
export function toText(output: unknown): string {
	if (!Array.isArray(output)) return "";
	return output
		.filter((block) => block && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => (block as { text: string }).text)
		.join("");
}

/**
 * Forward an agent's settings onto a subagent start request. Each present
 * field becomes the corresponding harness request field; absent fields keep
 * the harness defaults (parent options, deployment persona, unrestricted
 * tools, no schema, no depth cap). The system prompt travels on the agent's
 * first-class field; the harness names that request field `persona`.
 * `includeOutputSchema=false` (the continuable path) drops `outputSchema` —
 * structurally unsupported there.
 */
function applySettings(
	request: SubagentStartRequest,
	agent: Agent | null | undefined,
	options: { includeOutputSchema: boolean },
): void {
	const settings: AgentSettings | undefined = agent?.settings;
	if (settings?.agentOptions != null) request.agentOptions = settings.agentOptions;
	if (options.includeOutputSchema && settings?.outputSchema != null) request.outputSchema = settings.outputSchema;
	if (typeof settings?.maxDepth === "number" && Number.isFinite(settings.maxDepth)) request.maxDepth = settings.maxDepth;
	if (settings?.toolFilter != null) request.toolFilter = settings.toolFilter;
	const systemPrompt = agent && typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";
	if (systemPrompt.trim().length > 0) request.persona = systemPrompt;
}

/** The agent's display label (name, or its id when unnamed). */
export function agentLabel(agent: Agent | null | undefined, id: string): string {
	return agent && typeof agent.name === "string" && agent.name.length > 0 ? agent.name : id;
}

/** Outcome of one per-agent execution primitive. */
export interface OneAgentOutcome {
	/** Adopted output string (rendered JSON when structured, else joined text). */
	output: string;
	/** Harness stop reason of the run ("aborted"/"error" on failure). */
	stopReason?: string;
	/** The published child session id; absent when the start itself failed. */
	childSessionId?: string;
	/** Failure detail; present exactly when the run threw. */
	error?: string;
}

/**
 * Run ONE pipeline agent as a one-shot `subagents.start("spawn", ...)` child:
 * compose the prompt from the agent's structured input (the execution
 * contract), forward the agent's settings, await the result, prefer a
 * validated structured value, and always dispose the run. Errors are captured
 * in the outcome (`error` + a mapped stop reason), never thrown — an aborted
 * signal surfaces as `stopReason: "aborted"`, matching the pipeline executor's
 * historical behaviour.
 *
 * Consumed by `runPipeline`, by the durable run registry (one-shot agents and
 * Rerun's degraded path), and by the future isolation-test feature.
 */
export async function runOneAgent(
	ctx: RunnerContext,
	options: { agent: Agent | null | undefined; agentById: unknown; inputs: AgentExecutionInput; parent: unknown; signal?: AbortSignal },
): Promise<OneAgentOutcome> {
	const { agent, agentById, inputs, parent } = options;
	const signal = options.signal ?? new AbortController().signal;
	const id = agent && agent.id != null ? String(agent.id) : "";
	const prompt = agentPrompt(agent, inputs, agentById);
	const label = agentLabel(agent, id);

	const request: SubagentStartRequest = {
		label,
		prompt: [{ type: "text", text: prompt }],
		parent,
		signal,
	};
	applySettings(request, agent, { includeOutputSchema: true });

	try {
		const run = await ctx.subagents.start(PROVIDER, request);
		let result: SubagentResult;
		try {
			result = await run.result;
		} finally {
			try { await run.dispose(); } catch { /* disposal failure must not mask the result */ }
		}
		// A validated structured result (outputSchema set) is preferred over
		// the raw text output; the rendered JSON string flows downstream.
		const output = result.structured !== undefined ? renderValue(result.structured) : toText(result.output);
		return {
			output,
			stopReason: result.stopReason ?? "unknown",
			childSessionId: typeof run.id === "string" ? run.id : undefined,
		};
	} catch (error) {
		// An aborted signal can reject the start itself (the driver's
		// pre-publication abort) — record it as the abort it is, not an error.
		ctx.logger.warn(`agent-pipeline: agent "${id}" run failed: ${String(error)}`);
		return { output: "", stopReason: signal.aborted ? "aborted" : "error", error: String(error) };
	}
}

/**
 * Establish ONE breakpointed agent as a continuable child:
 * `subagents.startContinuable(...)` reserves the durable child identity,
 * composes the child, and accepts the initial prompt — resolving with the
 * child id WITHOUT waiting for the turn. Settlement arrives separately as a
 * `subagent/end` event for that child id (epoch-relative output; see
 * subscribeRunEnd). The continuable request mirrors the one-shot request
 * except `outputSchema`, which continuable children cannot produce.
 *
 * The caller supplies the PARENT: the node's disposable parent-anchor agent
 * (never the user's session agent — settlement notices wake the parent with a
 * real model turn). Throws on failure; the child id is authoritative on success.
 */
export async function startContinuableAgent(
	ctx: RunnerContext,
	options: { agent: Agent | null | undefined; agentById: unknown; prompt: string; parent: unknown; signal?: AbortSignal },
): Promise<{ childId: string }> {
	const { agent, agentById, prompt, parent } = options;
	const signal = options.signal ?? new AbortController().signal;
	const id = agent && agent.id != null ? String(agent.id) : "";
	const label = agentLabel(agent, id);

	const request: ContinuableStartSpecLike["request"] = {
		prompt: [{ type: "text", text: prompt }],
		parent,
	};
	applySettings(request as SubagentStartRequest, agent, { includeOutputSchema: false });

	const start = ctx.subagents.startContinuable;
	if (typeof start !== "function") throw new Error("continuable subagents are not available in this deployment");
	const accepted = await start.call(ctx.subagents, {
		provider: PROVIDER,
		label,
		request,
		signal,
	});
	const childId = accepted && typeof accepted.childId === "string" ? accepted.childId : "";
	if (childId.length === 0) throw new Error("continuable start returned no child id");
	return { childId };
}

/**
 * Deliver a steering turn to a continuable child: `subagents.followup` to the
 * SAME child (cold-resuming it from its persisted session when it is not
 * resident — this works across profile restarts). The caller must ensure the
 * parent is the child's exact live parent agent (the node's parent anchor) and
 * must dispose it after acceptance; the settlement then arrives as a
 * `subagent/end` event whose output is epoch-relative (the new answer only).
 */
export async function steerContinuableAgent(
	ctx: RunnerContext,
	options: { parent: unknown; childId: string; feedback: string; signal?: AbortSignal },
): Promise<void> {
	const followup = ctx.subagents.followup;
	if (typeof followup !== "function") throw new Error("steering requires continuable subagent support");
	const signal = options.signal ?? new AbortController().signal;
	await followup.call(ctx.subagents, options.parent, options.childId, [{ type: "text", text: options.feedback }], {
		source: { kind: "user" },
		signal,
	});
}

/**
 * Run one validated pipeline graph sequentially (the original blocking
 * executor — kept for direct/tested use; the Host's durable run registry does
 * NOT go through this anymore).
 *
 * @param ctx - the plugin context exposing `agents`, `subagents`, and `logger`.
 * @param options - `{ graph, input, sessionId, signal? }`.
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
	const runs: Array<{ id: string; label: string; status: string; output?: string; error?: string; childSessionId?: string }> = [];

	for (const id of order) {
		// Cancellation gate: once the caller aborts, no further agent starts.
		if (signal.aborted) break;
		const agent = agentById.get(id);
		const upstream = classified.upstream[id] ?? [];
		const inputs = agentInput(id, { upstream, upstreamOutputs: outputsById, pipelineInput: input });
		const label = agentLabel(agent, id);
		const outcome = await runOneAgent(ctx, { agent, agentById, inputs, parent, signal });
		// A failed run publishes no output (downstream receives undefined, exactly
		// as before the runOneAgent extraction).
		if (!outcome.error) outputsById[id] = outcome.output;
		runs.push({
			id,
			label,
			status: outcome.error ? (signal.aborted ? "aborted" : "error") : (outcome.stopReason ?? "unknown"),
			...(outcome.error ? { error: outcome.error } : { output: outcome.output }),
			...(outcome.childSessionId ? { childSessionId: outcome.childSessionId } : {}),
		});
	}

	const result = pipelineResult(classified.terminals, outputsById);
	return { ok: true, outputs: result.outputs, runs, order, ...(signal.aborted ? { aborted: true } : {}) };
}
