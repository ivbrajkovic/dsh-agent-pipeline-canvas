// dsh-agent-pipeline-canvas — Host half.
//
// The canvas is a browser-side feature (see ./client.tsx); the Host half exists
// so the graph can be made durable per repository. It registers two exact
// routes on the existing `webServer` service (the browser HTTP carrier, row
// `webserver`), and the browser half fetch()es them same-origin to load and
// save the project's pipeline:
//
//   GET  /dsh-agent-pipeline?cwd=<absolute project root>
//        -> { ok: true, pipeline: <graph> | null }   (no file yet => null)
//   POST /dsh-agent-pipeline   body { cwd, graph }
//        -> { ok: true }                             (writes the file)
//   POST /dsh-agent-pipeline/run  body { sessionId, graph, input }
//        -> { ok, outputs, runs, order }             (runs the pipeline snapshot;
//          aborted early when the browser connection closes — see the run
//          route's cancellation note below)
//   GET  /dsh-agent-pipeline/options?provider=<route id>
//        -> { ok, providers, models, provider }      (the registered LLM
//          provider routes for the config modal's dropdowns; `models` are
//          the advertised models of one route, `provider` the route the models
//          belong to. Read server-side off the `llm` service — per-provider
//          model catalogs are not remotely callable, so the browser reads
//          them through this plugin route. Degrades to empty lists.)
//
// The run route is a minimal, sequential executor: it validates the snapshot,
// resolves the session's live Agent as the parent, and runs each pipeline agent
// as a fresh `spawn` subagent in deterministic topological order, passing each
// output downstream (see lib/runner.ts). It reuses the harness's own `subagents`
// service — no separate agent execution mechanism.
//
// Storage: `<cwd>/.agent-pipeline/pipeline.json`, written atomically (temp file
// + rename) so a crash mid-write never leaves a truncated file. The pipeline
// belongs to the workspace / repo where the Agent Pipeline view is opened; a
// different repository has its own project root and therefore its own file.
//
// Trust model (local, single-user tool): the browser supplies the cwd, which is
// the workspace root the session already resolved (the view reads it off the
// session's own summary). The Host only ever appends `.agent-pipeline/
// pipeline.json` under that absolute path; it refuses a relative or empty cwd,
// so the file cannot land outside a real project directory. No data is returned
// back to the browser other than the graph itself or `{ ok }` / `{ ok: false }`.

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateGraph } from "./graph.ts";
import { runPipeline, type RunnerContext } from "./runner.ts";
import type { PipelineGraph } from "./types.ts";

const name = "agent-pipeline-canvas";
// `webServer` serves the routes; `agents` resolves the live session Agent that
// acts as the parent of every pipeline subagent; `subagents` runs each agent;
// `llm` answers the options route's provider/model directory.
const inject = ["webServer", "agents", "subagents", "llm"];

/** Same-origin route the browser half loads/saves through. */
const ROUTE_PATH = "/dsh-agent-pipeline";
/** Same-origin route that runs a pipeline snapshot (see lib/runner.ts). */
const RUN_PATH = "/dsh-agent-pipeline/run";
/** Same-origin route serving the provider/model directory (the settings panel). */
const OPTIONS_PATH = "/dsh-agent-pipeline/options";
/** Storage directory and file under the project root. */
const PIPELINE_DIR = ".agent-pipeline";
const PIPELINE_FILE = "pipeline.json";

// ---- Minimal, structural views of the harness services this half touches ----
// As in runner.ts, these are NOT the full @deepseek-ai/cordis types: this is a
// zero-runtime-dep local plugin, so it names only the fields it calls.

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
	register(route: { kind: "exact"; path: string; handler: RouteHandler }): unknown;
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
}

/**
 * Resolve the pipeline file path for a project root, or null when `cwd` is not
 * a usable absolute directory path. The literal `.agent-pipeline/pipeline.json`
 * suffix is appended verbatim, so there is no path-traversal surface here.
 * @param cwd - the project root (workspace directory) the browser supplied.
 * @returns the absolute pipeline file path, or null to reject the request.
 */
function pipelinePath(cwd: unknown): string | null {
	if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return null;
	return join(cwd, PIPELINE_DIR, PIPELINE_FILE);
}

/**
 * Durably replace `path` with `data`: write a same-directory temp file, fsync
 * it, then `rename()` over the target (atomic on POSIX and Windows). A failed
 * write cleans up the temp file. Mirrors the product's JSON-storage backend
 * write protocol, so one writer (this process) publishing whole files is safe.
 * @param path - absolute target file path.
 * @param data - full new file content.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
	const dir = dirname(path);
	const tmp = join(dir, `.${randomUUID()}.tmp`);
	try {
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
	} catch (error) {
		try { await rm(tmp, { force: true }); } catch { /* best-effort cleanup */ }
		throw error;
	}
}

/** Buffer and decode a request body (the client emits JSON). */
function readBody(req: ServerRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => { chunks.push(chunk as Buffer); });
		req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
		req.on("error", reject);
	});
}

/** Write a JSON response with no-store and end the request. */
function send(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(payload));
}

/**
 * Mount the pipeline persistence route on this plugin's fiber, so an unload
 * removes it.
 * @param ctx - registrant context carrying the webServer service.
 */
export function apply(ctx: HostContext): void {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const method = req.method ?? "GET";

			try {
				if (method === "GET") {
					const path = pipelinePath(url.searchParams.get("cwd") ?? "");
					if (path === null) {
						send(res, 400, { ok: false, error: "invalid or missing cwd" });
						return;
					}
					let pipeline: unknown = null;
					try {
						const text = await readFile(path, "utf8");
						try {
							pipeline = JSON.parse(text);
						} catch {
							// A malformed file degrades to "no pipeline" rather than
							// failing the view; the next save rewrites it cleanly.
							pipeline = null;
						}
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					// `validation` is additive: the browser computes the same result
					// client-side, but returning it here gives any consumer (e.g. a
					// future runner) the authoritative DAG check for the on-disk graph.
					send(res, 200, { ok: true, pipeline, validation: validateGraph(pipeline) });
					return;
				}

				if (method === "POST") {
					const body = await readBody(req);
					let payload: unknown;
					try {
						payload = JSON.parse(body);
					} catch {
						send(res, 400, { ok: false, error: "request body is not valid JSON" });
						return;
					}
					if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
						send(res, 400, { ok: false, error: "request body must be a JSON object" });
						return;
					}
					const rec = payload as { cwd?: unknown; graph?: unknown };
					const path = pipelinePath(rec.cwd);
					if (path === null) {
						send(res, 400, { ok: false, error: "invalid or missing cwd" });
						return;
					}
					await mkdir(dirname(path), { recursive: true });
					await writeAtomic(path, `${JSON.stringify(rec.graph, null, 2)}\n`);
					// Still persist the graph (the canvas may be mid-edit); the
					// validation result is returned so callers can surface issues
					// without the Host changing its write behaviour.
					send(res, 200, { ok: true, validation: validateGraph(rec.graph) });
					return;
				}

				send(res, 405, { ok: false, error: "method not allowed" });
			} catch (error) {
				ctx.logger.warn(`agent-pipeline: ${ROUTE_PATH} failed: ${String(error)}`);
				send(res, 500, { ok: false, error: "pipeline storage error" });
			}
		},
	}));

	// Run a pipeline snapshot: the browser POSTs the graph it currently shows
	// plus the pipeline-level input and its session id. The Host validates the
	// snapshot, runs it sequentially (see lib/runner.ts), and returns the
	// contract's `{ outputs: { [terminalId]: output } }` shape.
	//
	// Cancellation: each run gets its own AbortController, aborted the moment
	// the browser connection closes before the response completed (Stop button
	// aborting the fetch, tab closed, page reloaded). The runner passes the
	// signal down to the harness subagents, so the in-flight agent stops
	// mid-run and no further agent is started. The late response to a gone
	// client is dropped.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: RUN_PATH,
		handler: async (req, res) => {
			const method = req.method ?? "GET";
			if (method !== "POST") {
				send(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			try {
				const body = await readBody(req);
				let payload: unknown;
				try {
					payload = JSON.parse(body);
				} catch {
					send(res, 400, { ok: false, error: "request body is not valid JSON" });
					return;
				}
				if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
					send(res, 400, { ok: false, error: "request body must be a JSON object" });
					return;
				}
				const rec = payload as { graph?: unknown; input?: unknown; sessionId?: unknown };
				const controller = new AbortController();
				let clientGone = false;
				// res "close" with a not-yet-ended body is the reliable
				// client-disconnect signal (req "close" merely marks the
				// end of the request body).
				res.on("close", () => {
					if (!res.writableEnded) {
						clientGone = true;
						controller.abort();
					}
				});
				const result = await runPipeline(ctx, {
					graph: rec.graph as PipelineGraph | null | undefined,
					input: rec.input,
					sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
					signal: controller.signal,
				});
				if (clientGone) return;
					send(res, 200, result);
				} catch (error) {
					ctx.logger.warn(`agent-pipeline: ${RUN_PATH} failed: ${String(error)}`);
					send(res, 500, { ok: false, error: "pipeline run error" });
				}
			},
		}));

	// Provider/model directory for the settings panel: the
	// registered LLM provider routes plus, for one route, the models its
	// adapter advertises. Read server-side off the `llm` service (per-provider
	// model catalogs are not remotely callable), so the browser fetches this
	// plugin route instead. Deliberately degrade-not-fail: an unavailable
	// catalog answers `{ ok: false }` and the client keeps the fields
	// free-form (the harness accepts any adapter-resolvable id).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: OPTIONS_PATH,
		handler: async (req, res) => {
			const method = req.method ?? "GET";
			if (method !== "GET") {
				send(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			try {
				const url = new URL(req.url ?? "/", "http://x");
				const providers: Array<{ id: string; name: string }> = [];
				for (const entry of ctx.llm.listProviders()) {
					if (entry == null || typeof entry.id !== "string" || entry.id.length === 0) continue;
					providers.push({
						id: entry.id,
						name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
					});
				}
				const requested = url.searchParams.get("provider") ?? "";
				const providerId = providers.some((p) => p.id === requested)
					? requested
					: (providers.length > 0 ? providers[0].id : "");
				const models: Array<{ id: string; name: string; description?: string }> = [];
				if (providerId.length > 0) {
					try {
						for (const entry of await ctx.llm.listModels(providerId)) {
							if (entry == null || typeof entry.id !== "string" || entry.id.length === 0) continue;
							models.push({
								id: entry.id,
								name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
								...(typeof entry.description === "string" && entry.description.length > 0
									? { description: entry.description }
									: {}),
							});
						}
					} catch {
						// An adapter without a catalog keeps the list empty; the model
						// field stays free-form.
					}
				}
				send(res, 200, { ok: true, providers, models, provider: providerId });
			} catch (error) {
				ctx.logger.warn(`agent-pipeline: ${OPTIONS_PATH} failed: ${String(error)}`);
				send(res, 200, { ok: false, error: "model catalog unavailable" });
			}
		},
	}));
}

export { name, inject };
