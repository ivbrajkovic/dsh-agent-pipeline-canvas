import { type RunnerContext } from "./runner.ts";
declare const name = "agent-pipeline-canvas";
declare const inject: string[];
interface ServerRequest {
    url?: string;
    method?: string;
    on(event: string, cb: (...args: unknown[]) => void): void;
}
interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
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
    }): unknown;
}
/** The slice of the plugin context the Host half needs (extends RunnerContext). */
interface HostContext extends RunnerContext {
    webServer: WebServerService;
    effect(fn: () => unknown): unknown;
}
/**
 * Mount the pipeline persistence route on this plugin's fiber, so an unload
 * removes it.
 * @param ctx - registrant context carrying the webServer service.
 */
export declare function apply(ctx: HostContext): void;
export { name, inject };
//# sourceMappingURL=index.d.ts.map