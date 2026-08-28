// dsh-agent-pipeline-canvas — execution contract (runtime input/output shapes).
//
// This module is the single authoritative definition of the EXECUTION contract a
// runner relies on. Given the persisted, already-validated graph (the same
// `{ agents, connections }` DAG defined by ./graph.ts), it defines:
//
//   (a) how to classify each agent — root / terminal / orphan;
//   (b) exactly what input each agent receives;
//   (c) a deterministic default for framing that input into the agent's prompt;
//   (d) the shape of the pipeline's final result.
//
// It is intentionally PURE (no Node/browser APIs, no I/O, no React, no
// scheduling, no agent invocation, no model/tool selection) so it can be
// imported by the Host and the runner and exercised in a plain Node script
// (test/execution.test.ts). Scheduling, retries, conditions, loops, model
// selection, tool configuration, and credentials are the runner's job and are
// deliberately OUT OF SCOPE here.
//
// ## The contract (conventions — no new node types, no persisted schema change)
//
// Every agent receives exactly ONE structured input, always an OBJECT keyed by
// source. There is exactly one keying rule — the source of the value — so a
// single-upstream agent and a fan-in agent are the SAME case (1 key vs N keys);
// the runner never branches on "how many upstreams". The four input source
// classes map to the existing graph as follows:
//
//   - ROOT agent   (in-degree 0, includes orphans): receives the pipeline-level
//     input under the reserved key INPUT_KEY ("$input").
//   - FAN-OUT / SINGLE-UPSTREAM / FAN-IN agent (in-degree >= 1): receives
//     `{ [upstreamId]: <output> }` — one key per upstream agent, in a
//     deterministic (sorted by id) order.
//
// The pipeline's FINAL result is always `{ outputs: { [terminalId]: <output> } }`
// — keyed by terminal id (out-degree 0), `{}` when there are no terminals, and
// only for terminals that actually produced an output.
//
// An ORPHAN agent (in-degree 0 AND out-degree 0) is a valid DAG member that does
// nothing on its own. The contract RUNS it as a root + terminal singleton (it
// receives the pipeline input, runs, and its output is collected in `outputs`),
// because that is the least-surprising DAG interpretation and needs no special
// rule. A runner MAY surface an orphan as an "isolated agent" warning in its
// status, but the contract does not skip or special-case it.
//
// ## Why no persisted schema change
//
// Everything above is derivable from the existing `agents` / `connections`
// arrays — in-degree, out-degree, and upstream/downstream adjacency — plus ONE
// runtime parameter, the pipeline-level input `pipelineInput`. The per-agent
// `instructions` / `name` / `description` fields already exist and are reused
// (instructions as the prompt seed; name/description to label a source in the
// prompt and a terminal in status/result). The only reserved name is INPUT_KEY,
// which cannot collide with a canvas-generated agent id (`agent-N`; ids are not
// user-editable in the UI), so nothing new has to be persisted.
//
// ## Delivery form (prompt)
//
// The harness runs an agent with a single text prompt (a `content` block), so
// the runner must frame the structured input into a string. agentPrompt() below
// is the DEFAULT, deterministic framing: the agent's `instructions` followed by
// one "## <source label>" section per input key. This is a documented convention
// (not a schema change and not a restriction) — a runner may override it per
// node, but the shape of agentInput() is the stable contract.

import type {
	Agent,
	AgentExecutionInput,
	AgentInputContext,
	ClassifiedGraph,
	PipelineExecutionResult,
} from "./types.ts";

/** Reserved key that carries the pipeline-level input to a root agent. */
export const INPUT_KEY = "$input";

function idOf(value: unknown): string {
	return value == null ? "" : String(value);
}

/** Deterministic byte-order comparison (pure; identical across runtimes). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Derive the runtime structure of a graph. This is the classification a runner
 * uses to decide what to run, feed, and collect. It is derived purely from the
 * connection topology (source/target), the same view validateGraph uses.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined.
 * @returns the classification: `agents`, `roots`, `terminals`, `orphans`,
 *   `upstream` and `downstream` adjacency (sorted, deduped id lists).
 */
export function classifyGraph(graph: unknown): ClassifiedGraph {
	const asGraph = (graph ?? {}) as { agents?: unknown; connections?: unknown };
	const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
	const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];

	const agentIds: string[] = [];
	const upstreamSet = new Map<string, Set<string>>(); // id -> Set(upstream ids)
	const downstreamSet = new Map<string, Set<string>>(); // id -> Set(downstream ids)

	for (const agent of agents) {
		const rec = agent as { id?: unknown } | null | undefined;
		if (rec == null || typeof agent !== "object") continue;
		const id = idOf(rec.id);
		if (id.length === 0) continue;
		agentIds.push(id);
		upstreamSet.set(id, new Set());
		downstreamSet.set(id, new Set());
	}

	const known = new Set(agentIds);
	for (const conn of connections) {
		const rec = conn as { source?: unknown; target?: unknown } | null | undefined;
		if (rec == null || typeof conn !== "object") continue;
		const source = idOf(rec.source);
		const target = idOf(rec.target);
		if (source.length === 0 || target.length === 0) continue;
		if (!known.has(source) || !known.has(target)) continue;
		if (source === target) continue;
		downstreamSet.get(source)?.add(target);
		upstreamSet.get(target)?.add(source);
	}

	const roots: string[] = [];
	const terminals: string[] = [];
	const orphans: string[] = [];
	const upstream: Record<string, string[]> = {};
	const downstream: Record<string, string[]> = {};

	for (const id of agentIds) {
		const ups = [...(upstreamSet.get(id) ?? new Set<string>())].sort(cmp);
		const downs = [...(downstreamSet.get(id) ?? new Set<string>())].sort(cmp);
		upstream[id] = ups;
		downstream[id] = downs;
		if (ups.length === 0) roots.push(id);
		if (downs.length === 0) terminals.push(id);
		if (ups.length === 0 && downs.length === 0) orphans.push(id);
	}

	return { agents: agentIds, roots, terminals, orphans, upstream, downstream };
}

/**
 * Compute a deterministic execution order for a graph's agents. Kahn's
 * algorithm: a node becomes ready only once EVERY upstream agent has been
 * emitted — the fan-in "wait for all upstreams" rule — and ready nodes are
 * popped in stable (id) order so the result is independent of connection-array
 * order. The runner executes this order sequentially.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined.
 * @returns the agent ids in a deterministic topological order. A validated DAG
 *   yields every agent; a graph with a cycle is premature here (validateGraph
 *   rejects it first), and the order is truncated at the cycle rather than
 *   looping.
 */
export function topoOrder(graph: unknown): string[] {
	const { agents, upstream, downstream } = classifyGraph(graph);
	const indeg: Record<string, number> = {};
	for (const id of agents) indeg[id] = upstream[id].length;

	const ready = agents.filter((id) => indeg[id] === 0);
	const order: string[] = [];
	while (ready.length > 0) {
		ready.sort(cmp);
		const id = ready.shift() as string;
		order.push(id);
		for (const next of downstream[id]) {
			indeg[next] -= 1;
			if (indeg[next] === 0) ready.push(next);
		}
	}
	return order;
}

/**
 * Build the structured input an agent receives. This is THE input contract:
 * always an object keyed by source.
 *
 * @param agentId - the agent whose input is being built (used only in the
 *   source-label sense; not strictly required, kept for symmetry/robustness).
 * @param ctx - `{ upstream, upstreamOutputs, pipelineInput }`.
 *   - `upstream`       the sorted upstream id list for this agent (from classifyGraph).
 *   - `upstreamOutputs` map of upstream agent id -> that agent's output string.
 *   - `pipelineInput`  the single pipeline-level input (for roots).
 * @returns an object keyed by source: `{ [INPUT_KEY]: pipelineInput }` for a
 *   root, else `{ [upstreamId]: <output> }` for every upstream.
 */
export function agentInput(agentId: string, ctx: AgentInputContext): AgentExecutionInput {
	const upstream = Array.isArray(ctx?.upstream) ? ctx.upstream : [];
	const upstreamOutputs = ctx?.upstreamOutputs ?? {};
	const inputs: AgentExecutionInput = {};

	if (upstream.length === 0) {
		inputs[INPUT_KEY] = ctx?.pipelineInput;
	} else {
		for (const id of upstream) inputs[id] = upstreamOutputs[id];
	}
	return inputs;
}

/**
 * Render a value as prompt text: verbatim strings, structured values as JSON.
 * Shared with the message-composition module so the Host prompt framing and
 * the client's result framing render values identically.
 */
export function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** A per-agent prompt source shape (name/instructions read as optional). */
interface PromptSource {
	id?: unknown;
	name?: unknown;
	instructions?: unknown;
}

/** Resolve an agent's metadata for labelling (accepts a Map or a plain object). */
function lookupAgent(agentById: unknown, id: string): unknown {
	if (agentById == null) return undefined;
	if (typeof (agentById as { get?: unknown }).get === "function") {
		return (agentById as Map<string, unknown>).get(id);
	}
	return (agentById as Record<string, unknown>)[id];
}

/** The human-readable label for a source key in the prompt. */
function sourceLabel(key: string, agentById: unknown): string {
	if (key === INPUT_KEY) return "Input";
	const agent = lookupAgent(agentById, key);
	const name = (agent as PromptSource | undefined)?.name;
	if (typeof name === "string" && name.length > 0) return name;
	return key;
}

/**
 * Frame an agent's structured input into the prompt string a runner hands the
 * agent. DEFAULT framing (a documented convention, overridable by the runner):
 * the agent's `instructions` first, then one "## <source label>" section per
 * input key. Deterministic given the input object.
 *
 * @param agent - the agent entry (uses `instructions` / `name`).
 * @param inputs - the object returned by agentInput().
 * @param agentById - Map or object id -> agent, used to label upstream sources.
 * @returns the prompt string.
 */
export function agentPrompt(
	agent: Agent | null | undefined,
	inputs: AgentExecutionInput,
	agentById: unknown,
): string {
	const blocks: string[] = [];
	const instructions = typeof agent?.instructions === "string" ? agent.instructions : "";
	if (instructions.length > 0) blocks.push(instructions);

	const keys = Object.keys(inputs ?? {});
	for (const key of keys) {
		const body = renderValue(inputs[key]);
		blocks.push("## " + sourceLabel(key, agentById) + (body.length > 0 ? "\n" + body : ""));
	}
	return blocks.join("\n\n");
}

/**
 * Assemble the pipeline's final result. THE output contract: always
 * `{ outputs: { [terminalId]: <output> } }`, keyed by terminal id, including
 * only terminals that produced an output.
 *
 * @param terminalIds - the sorted terminal id list (from classifyGraph).
 * @param outputsById - map of agent id -> its output.
 * @returns `{ outputs }`.
 */
export function pipelineResult(
	terminalIds: ReadonlyArray<string> | null | undefined,
	outputsById: Record<string, unknown> | null | undefined,
): PipelineExecutionResult {
	const outputs: Record<string, unknown> = {};
	for (const id of terminalIds ?? []) {
		const value = outputsById ? outputsById[id] : undefined;
		if (value !== undefined) outputs[id] = value;
	}
	return { outputs };
}
