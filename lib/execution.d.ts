import type { Agent, AgentExecutionInput, AgentInputContext, ClassifiedGraph, PortGraph, PipelineExecutionResult } from "./types.ts";
/** Reserved key that carries the pipeline-level input to a root agent. */
export declare const INPUT_KEY = "$input";
/** Deterministic byte-order comparison (pure; identical across runtimes). */
export declare function cmp(a: string, b: string): number;
/**
 * Derive the runtime structure of a graph. This is the classification a runner
 * uses to decide what to run, feed, and collect. It is derived purely from the
 * connection topology (source/target), the same view validateGraph uses.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined.
 * @returns the classification: `agents`, `roots`, `terminals`, `orphans`,
 *   `upstream` and `downstream` adjacency (sorted, deduped id lists).
 */
export declare function classifyGraph(graph: unknown): ClassifiedGraph;
/**
 * Compute a deterministic execution order for a graph's agents. Kahn's
 * algorithm: a node becomes ready only once EVERY upstream agent has been
 * emitted — the fan-in "wait for all upstreams" rule — and ready nodes are
 * popped in stable (id) order so the result is independent of connection-array
 * order. The runner executes this order sequentially.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined.
 * @returns the agent ids in a deterministic topological order. A validated
 *   acyclic graph yields every agent; a graph with a cycle truncates here —
 *   the sequential runner runs only the acyclic prefix (cycles are legal
 *   wiring for the stream executor; validateGraph reports them as a
 *   `cycle-present` warning, not an error).
 */
export declare function topoOrder(graph: unknown): string[];
/**
 * Derive the port-graph view of a graph: per agent, the declared input/output
 * ports (defaults applied) with every edge resolved onto them. This is the
 * shared derivation behind the stream node model — validateGraph consumes it
 * for port-wiring correctness, and the run kernel queues per-port messages
 * from it.
 *
 * Derivation rules:
 *   - `inputPorts` present  → one port per spec, wire id `<agentId>:<name>`;
 *     `outputPorts` present → one port per name, same wire id convention.
 *   - A list ABSENT → the single legacy default: the agent's `input` / `output`
 *     string (which already IS the wire id), else `<id>:in` / `<id>:out`. Old
 *     files keep wiring exactly as before.
 *   - Malformed declarations (non-object specs, empty/non-string names,
 *     non-positive-integer bounds) are skipped or normalized to the default —
 *     validateGraph reports them; this view stays total. Duplicate port names
 *     keep the first occurrence (validation reports the duplicate).
 *   - An edge attaches to a port only when the connection's port string names
 *     that port exactly; unmatched edges drop here (validation reports them as
 *     port mismatches).
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined.
 * @returns the port graph: agent ids (array order) and per-agent port views.
 */
export declare function portGraph(graph: unknown): PortGraph;
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
export declare function agentInput(agentId: string, ctx: AgentInputContext): AgentExecutionInput;
/**
 * Render a value as prompt text: verbatim strings, structured values as JSON.
 * Shared with the message-composition module so the Host prompt framing and
 * the client's result framing render values identically.
 */
export declare function renderValue(value: unknown): string;
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
export declare function agentPrompt(agent: Agent | null | undefined, inputs: AgentExecutionInput, agentById: unknown): string;
/**
 * Assemble the pipeline's final result. THE output contract: always
 * `{ outputs: { [terminalId]: <output> } }`, keyed by terminal id, including
 * only terminals that produced an output.
 *
 * @param terminalIds - the sorted terminal id list (from classifyGraph).
 * @param outputsById - map of agent id -> its output.
 * @returns `{ outputs }`.
 */
export declare function pipelineResult(terminalIds: ReadonlyArray<string> | null | undefined, outputsById: Record<string, unknown> | null | undefined): PipelineExecutionResult;
//# sourceMappingURL=execution.d.ts.map