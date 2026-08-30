import type { Agent, AgentExecutionInput, AgentSettings, PipelineRunRequest, PipelineRunResult } from "./types.ts";
/** The registered subagent provider to run each pipeline agent on (see base bundle). */
export declare const PROVIDER = "spawn";
interface SubagentResult {
    output?: unknown;
    structured?: unknown;
    stopReason?: string;
    /** Provider-authored failure detail for a non-`completed` result. */
    diagnostic?: string;
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
    startContinuable?(spec: ContinuableStartSpecLike): Promise<{
        childId?: string;
        messageId?: unknown;
    }>;
    /** Deliver a follow-up turn to a continuable child (cold-resumes it if needed). */
    followup?(parent: unknown, childId: string, content: unknown[], options: {
        source?: unknown;
        signal?: AbortSignal;
    }): Promise<unknown>;
    /** Interrupt a live continuable child's current turn (absent target = no-op). */
    interrupt?(childId: string, authority: {
        kind: "user";
        parentSessionId: string;
    }): void;
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
export declare function continuableSupported(ctx: RunnerContext): boolean;
/** Concatenate the text blocks of a subagent result into a single string. */
export declare function toText(output: unknown): string;
/** The agent's display label (name, or its id when unnamed). */
export declare function agentLabel(agent: Agent | null | undefined, id: string): string;
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
    /**
     * The provider's failure detail for a settled-but-not-`completed` result
     * (`SubagentResult.diagnostic` — the harness authors it for exactly this
     * presentation); absent otherwise. The fail-fast record composes it into
     * the firing's `error` beside the stop reason.
     */
    diagnostic?: string;
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
export declare function runOneAgent(ctx: RunnerContext, options: {
    agent: Agent | null | undefined;
    agentById: unknown;
    inputs: AgentExecutionInput;
    parent: unknown;
    signal?: AbortSignal;
}): Promise<OneAgentOutcome>;
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
export declare function startContinuableAgent(ctx: RunnerContext, options: {
    agent: Agent | null | undefined;
    agentById: unknown;
    prompt: string;
    parent: unknown;
    signal?: AbortSignal;
}): Promise<{
    childId: string;
}>;
/**
 * Deliver a steering turn to a continuable child: `subagents.followup` to the
 * SAME child (cold-resuming it from its persisted session when it is not
 * resident — this works across profile restarts). The caller must ensure the
 * parent is the child's exact live parent agent (the node's parent anchor) and
 * must dispose it after acceptance; the settlement then arrives as a
 * `subagent/end` event whose output is epoch-relative (the new answer only).
 */
export declare function steerContinuableAgent(ctx: RunnerContext, options: {
    parent: unknown;
    childId: string;
    feedback: string;
    signal?: AbortSignal;
}): Promise<void>;
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
export declare function runPipeline(ctx: RunnerContext, options: PipelineRunRequest): Promise<PipelineRunResult>;
export {};
//# sourceMappingURL=runner.d.ts.map