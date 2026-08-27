/** One pipeline agent node on the canvas. */
export interface Agent {
    id: string;
    name: string;
    description: string;
    instructions: string;
    x: number;
    y: number;
    /** The agent's single input port, `<id>:in` by convention. */
    input: string;
    /** The agent's single output port, `<id>:out` by convention. */
    output: string;
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
}
/** Failed run: invalid graph, missing parent Agent, or no provider registered. */
export interface PipelineRunFailure {
    ok: false;
    validationErrors?: ValidationError[];
    error?: string;
}
/** Discriminated union returned by the runner. */
export type PipelineRunResult = PipelineRunSuccess | PipelineRunFailure;
//# sourceMappingURL=types.d.ts.map