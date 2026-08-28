// dsh-agent-pipeline-canvas — shared contract types.
//
// The single authoritative set of TypeScript types for the pipeline's on-disk
// graph, validation, execution, and run contracts. Imported by the Host half
// (src/index.ts, src/runner.ts), the pure semantics modules (src/graph.ts,
// src/execution.ts), and the browser half (src/client.tsx).
//
// The browser half consumes these selectively:
//   - the runtime `validateGraph` function is imported from ./graph.ts and gets
//     BUNDLED into lib/client.js by tsdown (so both halves share one
//     implementation — no duplication);
//   - these pure type shapes are consumed as type-only imports, which the
//     compiler erases before the bundle is built, so the browser's module-table
//     require() resolution never has to answer a relative-file import.
//
// This module is intentionally PURE (no Node or browser APIs, no I/O) — types
// only — so it can be named by either half and erased without side effects.

/**
 * Per-agent settings, authored in the client's configuration panel and
 * persisted on the agent (they are settings, not run-time overrides: they are
 * saved with the graph and shape every run of that agent). Each present field
 * is forwarded as the corresponding harness `SubagentStartRequest` field (all
 * of them are supported by the `spawn` provider), so a pipeline agent can run
 * on a specific model, with restricted tools, a delegation-depth cap, or a
 * structured output schema. Absent fields inherit the defaults (the parent's
 * provider/model, unrestricted tools). The system prompt is NOT here — it is
 * a first-class field on Agent (see SYSTEM-PROMPT.md).
 */
export interface AgentSettings {
	/** Absolute delegation-depth cap for the child (`SubagentStartRequest.maxDepth`). */
	maxDepth?: number;
	/** Host-Agent options; each present field replaces the parent Agent's option. */
	agentOptions?: {
		/** Provider route (must have a registered adapter at call time). */
		provider?: string;
		/** Model id interpreted by the selected provider adapter. */
		model?: string;
		/** Adapter-owned reasoning-effort id (provider-specific, free-form). */
		reasoningEffort?: string;
		/** Maximum output tokens per model request. */
		maxTokens?: number;
	};
	/** Child tool scoping: global tool names to allow (others removed) or to deny. */
	toolFilter?: {
		allow?: string[];
		deny?: string[];
	};
	/**
	 * Object-rooted JSON Schema for the child's structured result
	 * (`SubagentStartRequest.outputSchema`). A successful child returns the
	 * matching value as `SubagentResult.structured`, which the runner prefers
	 * over the raw text output.
	 */
	outputSchema?: unknown;
}

/** One pipeline agent node on the canvas. */
export interface Agent {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/**
	 * The agent's system prompt — REAL system-prompt text. Forwarded as
	 * `SubagentStartRequest.persona` (the harness's field name), which the
	 * harness installs as the child's scoped `deployment:persona` system-prompt
	 * section (order 0), replacing that one slot for this child alone. The rest
	 * of the standard prompt — identity, delegation statement, policies, and
	 * every harness tool explanation — is inherited untouched (see
	 * SYSTEM-PROMPT.md). Absent/empty keeps the deployment default (on this
	 * deployment: unset, so just the fixed harness identity line).
	 */
	systemPrompt?: string;
	x: number;
	y: number;
	/** The agent's single input port, `<id>:in` by convention. */
	input: string;
	/** The agent's single output port, `<id>:out` by convention. */
	output: string;
	/** The agent's settings (see AgentSettings); absent fields inherit defaults. */
	settings?: AgentSettings;
}

/**
 * One directed edge from a source agent's output port to a target agent's input
 * port. `sourcePort`/`targetPort` are the `<id>:out` / `<id>:in` protocol ports,
 * but the on-disk / wire shape may omit or vary them (a hand-writer or a legacy
 * file); validation treats missing/mismatched ports as an error, never a panic.
 */
export interface Connection {
	id: string;
	source: string;
	target: string;
	/** `<source>:out`. */
	sourcePort: string;
	/** `<target>:in`. */
	targetPort: string;
}

/** The pipeline graph: the two arrays persisted to `.agent-pipeline/pipeline.json`. */
export interface PipelineGraph {
	agents: Agent[];
	connections: Connection[];
}

/** Stable discriminator + human-readable message for one validation problem. */
export interface ValidationError {
	code: string;
	message: string;
}

/** DAG validation result: `ok` is true exactly when `errors` is empty. */
export interface ValidationResult {
	ok: boolean;
	errors: ValidationError[];
}

/**
 * The input an agent receives: ALWAYS an object keyed by source. A root agent
 * gets the reserved INPUT_KEY ("$input"); every other agent gets one key per
 * upstream agent id (deterministic, sorted-by-id order).
 */
export type AgentExecutionInput = Record<string, unknown>;

/**
 * The pipeline-level input value, given unmasked to every root agent under the
 * reserved INPUT_KEY.
 */
export type PipelineInput = unknown;

/** The contract's final result shape: `{ outputs: { [terminalId]: output } }`. */
export interface PipelineExecutionResult {
	outputs: Record<string, unknown>;
}

/** Classification of a graph: known ids + root/terminal/orphan sets + adjacency. */
export interface ClassifiedGraph {
	agents: string[];
	roots: string[];
	terminals: string[];
	orphans: string[];
	upstream: Record<string, string[]>;
	downstream: Record<string, string[]>;
}

/** Input for building one agent's input object (see agentInput). */
export interface AgentInputContext {
	upstream: string[];
	upstreamOutputs: Record<string, unknown>;
	pipelineInput?: PipelineInput;
}

/** Per-agent status record reported on a run. */
export interface AgentRunRecord {
	id: string;
	label: string;
	status: string;
	output?: string;
	error?: string;
	/**
	 * The published child session id of this agent's run (`SubagentRun.id`).
	 * The child session is durable and holds the full transcript, so the
	 * client can open it for inspection; absent when the start itself failed.
	 */
	childSessionId?: string;
}

/**
 * A pipeline run request: the snapshot the browser currently shows, the
 * pipeline-level input, and the live session id (the parent Agent for the whole
 * run).
 */
export interface PipelineRunRequest {
	graph: PipelineGraph | null | undefined;
	input?: PipelineInput;
	sessionId: string;
	signal?: AbortSignal;
}

/** Successful run: contract outputs + per-agent runs + deterministic order. */
export interface PipelineRunSuccess {
	ok: true;
	outputs: Record<string, unknown>;
	runs: AgentRunRecord[];
	order: string[];
	/**
	 * True when the run stopped early because the caller aborted the signal:
	 * the agent in flight at abort time is recorded with status "aborted" and
	 * the agents after it in the topological order never ran.
	 */
	aborted?: boolean;
}

/** Failed run: invalid graph, missing parent Agent, or no provider registered. */
export interface PipelineRunFailure {
	ok: false;
	validationErrors?: ValidationError[];
	error?: string;
}

/** Discriminated union returned by the runner. */
export type PipelineRunResult = PipelineRunSuccess | PipelineRunFailure;
