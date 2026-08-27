import type { PipelineRunRequest, PipelineRunResult } from "./types.ts";
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
export declare function runPipeline(ctx: RunnerContext, options: PipelineRunRequest): Promise<PipelineRunResult>;
export {};
//# sourceMappingURL=runner.d.ts.map