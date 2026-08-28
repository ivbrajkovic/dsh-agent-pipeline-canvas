import type { RunnerContext } from "./runner.ts";
declare const name = "agent-pipeline-canvas";
declare const inject: string[];
interface ServerRequest {
    url?: string;
    method?: string;
    on(event: string, cb: (...args: unknown[]) => void): void;
}
interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    write(chunk: string): unknown;
    end(data?: string): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    /** True once `end()` has been called AND the body flushed (node:http). */
    writableEnded?: boolean;
}
type RouteHandler = (req: ServerRequest, res: ServerResponse) => void | Promise<void>;
interface WebServerService {
    register(route: {
        kind: "exact";
        path: string;
        handler: RouteHandler;
    }): () => void;
}
/** Structural view of the `llm` service the options route reads (see lib types). */
interface LlmProviderInfoLike {
    id?: unknown;
    name?: unknown;
}
interface LlmModelInfoLike {
    id?: unknown;
    name?: unknown;
    description?: unknown;
}
interface LlmService {
    listProviders(): LlmProviderInfoLike[];
    listModels(provider: string): Promise<LlmModelInfoLike[]>;
}
/** The slice of the plugin context the Host half needs (extends RunnerContext). */
interface HostContext extends RunnerContext {
    webServer: WebServerService;
    llm: LlmService;
    effect(fn: () => unknown): unknown;
    /** Cordis event subscription (used for the `subagent/end` settlement seam). */
    on(event: string, listener: (payload: never) => void): () => void;
    /** Cordis service probe (used to feature-detect `sessionPersistence`). */
    get?(name: string): unknown | undefined;
}
/**
 * Mount the pipeline persistence + run routes on this plugin's fiber, so an
 * unload removes them and closes every open SSE stream.
 * @param ctx - registrant context carrying the webServer service.
 */
export declare function apply(ctx: HostContext): void;
export { name, inject };
//# sourceMappingURL=index.d.ts.map