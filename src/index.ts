// dsh-agent-pipeline-canvas — Host half.
//
// The canvas is a browser-side feature (see ./client.tsx); the Host half exists
// so the graph can be made durable per repository and pipelines can RUN
// durably. It registers exact routes on the existing `webServer` service (the
// browser HTTP carrier, row `webserver`); the browser half fetch()es them
// same-origin:
//
//   GET  /dsh-agent-pipeline?cwd=<absolute project root>
//        -> { ok, pipeline: <graph> | null, validation, run: <active record|null> }
//        (no file yet => null; `run` carries the workspace's active run record
//        — running or paused — so a reload discovers it without a list route)
//   POST /dsh-agent-pipeline   body { cwd, graph }
//        -> { ok, validation }                     (writes the file)
//   POST /dsh-agent-pipeline/run  body { sessionId, cwd, graph, input }
//        -> { ok, runId } | 409 { ok: false, activeRunId }
//        (starts a DURABLE run executor in the Host process and returns
//        immediately — see lib/runs.ts. Runs outlive the tab: there is NO
//        abort-on-client-disconnect here anymore.)
//   GET  /dsh-agent-pipeline/run?id=<runId>&cwd=<absolute project root>
//        -> { ok, run: <full record> }             (debug/fallback; curl-able)
//   GET  /dsh-agent-pipeline/run/events?id=<runId>&cwd=<absolute project root>
//        -> text/event-stream: `event: snapshot` (full record) on connect,
//           `event: update` per transition, `: ping` heartbeats. The browser
//           uses EventSource (same-origin auth like fetch; auto-reconnect
//           self-heals a profile restart).
//   POST /dsh-agent-pipeline/control body { runId, cwd, action, feedback? }
//        -> { ok } | { ok: false, error }   (resume | rerun | steer | abort)
//   GET  /dsh-agent-pipeline/options?provider=<route id>
//        -> { ok, providers, models, provider }    (the settings panel's
//          provider/model directory, read server-side off the `llm` service.
//          Degrades to empty lists.)
//
// Run execution: the run registry (lib/runs.ts) walks the graph's topological
// order sequentially. Non-breakpointed agents run as one-shot `spawn`
// subagents parented to the session agent; breakpointed agents run as
// continuable subagents under a disposable per-run coordinator agent (hidden,
// `origin: "subagent"`, delegationDepth 0), pausing at each breakpoint for the
// user's Resume / Rerun / Steer / Abort. Breakpointed agents require the
// harness continuable runtime (`subagents.startContinuable` +
// `sessionPersistence`, both mounted by the base bundle); when absent the
// plugin degrades: breakpointed agents run one-shot, steering is rejected,
// rerun still works.
//
// Storage: `<cwd>/.agent-pipeline/pipeline.json` and
// `<cwd>/.agent-pipeline/runs/<runId>.json`, both written atomically (temp
// file + rename — see lib/storage.ts) so a crash mid-write never leaves a
// truncated file. The pipeline and its runs belong to the workspace / repo
// where the Agent Pipeline view is opened; a different repository has its own
// project root and therefore its own files.
//
// Trust model (local, single-user tool): the browser supplies the cwd, which
// is the workspace root the session already resolved (the view reads it off
// the session's own summary). The Host only ever appends `.agent-pipeline/…`
// under that absolute path; it refuses a relative or empty cwd, so files
// cannot land outside a real project directory.

import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { validateGraph } from "./graph.ts";
import type { RunnerContext, SubagentRunEndInfoLike } from "./runner.ts";
import { RunRegistry } from "./runs.ts";
import { writeAtomic } from "./storage.ts";
import type { PipelineGraph } from "./types.ts";

const name = "agent-pipeline-canvas";
// `webServer` serves the routes; `agents` resolves the live session Agent that
// parents one-shot pipeline subagents (and seeds the per-run coordinator);
// `subagents` runs each agent; `llm` answers the options route's provider/model
// directory. `sessionPersistence` is deliberately NOT injected: it is
// feature-probed (ctx.get) so a deployment without it still loads the plugin
// and simply loses steering (see the degradation note above).
const inject = ["webServer", "agents", "subagents", "llm"];

/** Same-origin route the browser half loads/saves through. */
const ROUTE_PATH = "/dsh-agent-pipeline";
/** Same-origin route that starts a durable pipeline run (see lib/runs.ts). */
const RUN_PATH = "/dsh-agent-pipeline/run";
/** SSE stream of one run's record transitions. */
const RUN_EVENTS_PATH = "/dsh-agent-pipeline/run/events";
/** Same-origin route carrying run control commands (resume/rerun/steer/abort). */
const CONTROL_PATH = "/dsh-agent-pipeline/control";
/** Same-origin route serving the provider/model directory (the settings panel). */
const OPTIONS_PATH = "/dsh-agent-pipeline/options";
/** Storage directory and file under the project root. */
const PIPELINE_DIR = ".agent-pipeline";
const PIPELINE_FILE = "pipeline.json";
/** SSE heartbeat interval (a comment line; keeps intermediaries from idling out). */
const SSE_PING_MS = 15000;

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
	write(chunk: string): unknown;
	end(data?: string): void;
	on(event: string, cb: (...args: unknown[]) => void): void;
	/** True once `end()` has been called AND the body flushed (node:http). */
	writableEnded?: boolean;
}

type RouteHandler = (req: ServerRequest, res: ServerResponse) => void | Promise<void>;

interface WebServerService {
	register(route: { kind: "exact"; path: string; handler: RouteHandler }): () => void;
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

/** Buffer and decode a request body (the client emits JSON). */
function readBody(req: ServerRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => { chunks.push(chunk as Buffer); });
		req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
		req.on("error", reject);
	});
}

/** Parse a JSON object body, or null when the body is not valid JSON / not an object. */
async function readJsonObject(req: ServerRequest): Promise<Record<string, unknown> | null> {
	const body = await readBody(req);
	try {
		const payload: unknown = JSON.parse(body);
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
		return payload as Record<string, unknown>;
	} catch {
		return null;
	}
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
 * Mount the pipeline persistence + run routes on this plugin's fiber, so an
 * unload removes them and closes every open SSE stream.
 * @param ctx - registrant context carrying the webServer service.
 */
export function apply(ctx: HostContext): void {
	// The durable run registry: starts executors, persists records under the
	// workspace, sweeps stale runs, routes control commands. Settlements arrive
	// through the root-level `subagent/end` listener (events are filtered by
	// child id downstream; a root-level listener sees one-shot and continuable
	// settlements alike).
	const registry = new RunRegistry({
		agents: ctx.agents as unknown as ConstructorParameters<typeof RunRegistry>[0]["agents"],
		subagents: ctx.subagents,
		logger: ctx.logger,
		subscribeRunEnd: (fn) => ctx.on("subagent/end", (info: SubagentRunEndInfoLike) => fn(info)),
		sessionPersistence: typeof ctx.get === "function" ? ctx.get("sessionPersistence") : undefined,
	});

	// One SSE stream per connected browser tab. Plugin unload (the effect's
	// cleanup) ends every open response and removes its listeners — no leaks.
	const sseClients = new Set<{ res: ServerResponse; cleanup: () => void }>();
	function closeAllSse(): void {
		for (const client of [...sseClients]) {
			try { client.res.end(); } catch { /* already gone */ }
			client.cleanup();
		}
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const method = req.method ?? "GET";

			try {
				if (method === "GET") {
					const cwd = url.searchParams.get("cwd") ?? "";
					const path = pipelinePath(cwd);
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
					// `run` is the workspace's active run record (running|paused) —
					// the discovery path for a page reload; loading it also sweeps
					// stale runs and resurrects paused ones (see lib/runs.ts).
					const run = await registry.activeRunForCwd(cwd);
					send(res, 200, { ok: true, pipeline, validation: validateGraph(pipeline), ...(run !== null ? { run } : { run: null }) });
					return;
				}

				if (method === "POST") {
					const payload = await readJsonObject(req);
					if (payload === null) {
						send(res, 400, { ok: false, error: "request body must be a JSON object" });
						return;
					}
					const path = pipelinePath(payload.cwd);
					if (path === null) {
						send(res, 400, { ok: false, error: "invalid or missing cwd" });
						return;
					}
					await mkdir(join((payload.cwd as string), PIPELINE_DIR), { recursive: true });
					await writeAtomic(path, `${JSON.stringify(payload.graph, null, 2)}\n`);
					// Still persist the graph (the canvas may be mid-edit); the
					// validation result is returned so callers can surface issues
					// without the Host changing its write behaviour.
					send(res, 200, { ok: true, validation: validateGraph(payload.graph) });
					return;
				}

				send(res, 405, { ok: false, error: "method not allowed" });
			} catch (error) {
				ctx.logger.warn(`agent-pipeline: ${ROUTE_PATH} failed: ${String(error)}`);
				send(res, 500, { ok: false, error: "pipeline storage error" });
			}
		},
	}));

	// Start a durable run: validate the snapshot, then hand it to the registry.
	// The route returns `{ ok, runId }` immediately — the executor continues in
	// the Host process, persists every transition, and pauses at breakpoints.
	// Deliberately NO abort-on-client-disconnect: runs outlive the tab (a
	// reload re-discovers the active record via the pipeline GET's `run` field
	// and re-subscribes to the SSE stream).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: RUN_PATH,
		handler: async (req, res) => {
			const method = req.method ?? "GET";
			if (method === "GET") {
				// Debug/fallback read of one record (also curl-able).
				const url = new URL(req.url ?? "/", "http://x");
				const record = await registry.getRun(url.searchParams.get("id"), url.searchParams.get("cwd"));
				if (record === null) {
					send(res, 404, { ok: false, error: "no such run" });
					return;
				}
				send(res, 200, { ok: true, run: record });
				return;
			}
			if (method !== "POST") {
				send(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			try {
				const payload = await readJsonObject(req);
				if (payload === null) {
					send(res, 400, { ok: false, error: "request body must be a JSON object" });
					return;
				}
				const outcome = await registry.startRun({
					sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
					cwd: typeof payload.cwd === "string" ? payload.cwd : "",
					graph: (payload.graph ?? undefined) as PipelineGraph | undefined,
					input: payload.input,
					maxInFlight: payload.maxInFlight,
				});
				if (outcome.ok) {
					send(res, 200, { ok: true, runId: outcome.runId });
					return;
				}
				send(res, outcome.activeRunId !== undefined ? 409 : 400, { ok: false, error: outcome.error, ...(outcome.activeRunId !== undefined ? { activeRunId: outcome.activeRunId } : {}) });
			} catch (error) {
				ctx.logger.warn(`agent-pipeline: ${RUN_PATH} failed: ${String(error)}`);
				send(res, 500, { ok: false, error: "pipeline run error" });
			}
		},
	}));

	// SSE stream of one run's record: a full `snapshot` on every (re)connect,
	// then an `update` per persisted transition. EventSource's auto-reconnect
	// self-heals profile restarts (the fresh snapshot carries the resumed
	// state); heartbeats keep intermediaries from idling the stream out.
	ctx.effect(() => {
		const disposeRoute = ctx.webServer.register({
			kind: "exact",
			path: RUN_EVENTS_PATH,
			handler: async (req, res) => {
				const method = req.method ?? "GET";
				if (method !== "GET") {
					send(res, 405, { ok: false, error: "method not allowed" });
					return;
				}
				try {
					const url = new URL(req.url ?? "/", "http://x");
					const record = await registry.getRun(url.searchParams.get("id"), url.searchParams.get("cwd"));
					if (record === null) {
						send(res, 404, { ok: false, error: "no such run" });
						return;
					}
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-store",
						// The webserver's gzip filter exempts text/event-stream, so
						// writes flush immediately.
					});
					const writeEvent = (event: string, data: unknown): void => {
						if (res.writableEnded) return;
						try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ }
					};
					writeEvent("snapshot", record);
					const unsubscribe = registry.subscribe(record.runId, (updated) => { writeEvent("update", updated); });
					const ping = setInterval(() => {
						if (res.writableEnded) return;
						try { res.write(": ping\n\n"); } catch { /* gone */ }
					}, SSE_PING_MS);
					const client = {
						res,
						cleanup: () => {
							clearInterval(ping);
							if (unsubscribe !== null) unsubscribe();
							sseClients.delete(client);
						},
					};
					sseClients.add(client);
					res.on("close", () => { client.cleanup(); });
				} catch (error) {
					ctx.logger.warn(`agent-pipeline: ${RUN_EVENTS_PATH} failed: ${String(error)}`);
					send(res, 500, { ok: false, error: "run events error" });
				}
			},
		});
		return () => {
			closeAllSse();
			disposeRoute();
		};
	});

	// Run control: resume / rerun / steer / abort. Validated and routed by the
	// registry (which owns the executor mailbox); typed errors for wrong-state
	// commands, empty steering feedback, or missing runs.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: CONTROL_PATH,
		handler: async (req, res) => {
			const method = req.method ?? "GET";
			if (method !== "POST") {
				send(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			try {
				const payload = await readJsonObject(req);
				if (payload === null) {
					send(res, 400, { ok: false, error: "request body must be a JSON object" });
					return;
				}
				const outcome = await registry.control(
					payload.runId,
					{ action: payload.action, feedback: payload.feedback },
					payload.cwd,
				);
				send(res, outcome.ok ? 200 : 400, outcome);
			} catch (error) {
				ctx.logger.warn(`agent-pipeline: ${CONTROL_PATH} failed: ${String(error)}`);
				send(res, 500, { ok: false, error: "run control error" });
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

	// Unload: close every open SSE stream. The run registry's records are
	// intentionally left untouched — a paused run must survive an unload (and a
	// process death) on disk and be resurrected by the next load.
	ctx.effect(() => () => {
		closeAllSse();
		registry.dispose();
	});
}

export { name, inject };
