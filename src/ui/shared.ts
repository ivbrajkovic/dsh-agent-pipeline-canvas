// Shared primitives for the pipeline client components: module constants,
// the structural views of the harness client services (same discipline as the
// Host half — only the fields the client calls), the internal canvas state
// shapes, and the graph serialization helpers. No React here — components
// import react themselves.
//
// Every service the client touches must stay on the module entry's `inject`
// (src/client.tsx): the dynamic ctx proxy rejects property reads of undeclared
// services, and nested Remote namespaces need their own dotted entry.

import type { AgentSettings, PipelineGraph } from "../types.ts";

export const ENDPOINT = "/dsh-agent-pipeline";
export const SAVE_DEBOUNCE_MS = 250;

/** Stable empty selector results (identity matters to the snapshot hooks). */
export const EMPTY_ROWS: Record<string, SessionRow> = {};
export const EMPTY_ITEMS: Array<{ workspaceId?: string; path?: string; sessionIds?: readonly string[] }> = [];

// ---- Internal canvas state shapes ----

/** An agent node as held in React state (no wire ports; buildGraph adds them). */
export interface CanvasAgent {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/** First-class system prompt — real system-prompt text (see Agent in types.ts). */
	systemPrompt?: string;
	x: number;
	y: number;
	/** The agent's settings (see AgentSettings); absent fields inherit defaults. */
	settings?: AgentSettings;
}

/** A connection as held in React state (ports derived from source/target). */
export interface CanvasConnection {
	id: string;
	source: string;
	target: string;
}

/** The run-result object returned by the Host's /run route. */
export interface RunResultLike {
	ok?: boolean;
	outputs?: Record<string, unknown>;
	runs?: Array<{ id: string; label?: string; status?: string; error?: string; childSessionId?: string }>;
	error?: string;
	validationErrors?: Array<{ message?: string }>;
}

/** The useSessions feed: session list rows plus the current selection. */
export interface SessionSummary {
	byId?: Record<string, SessionRow>;
	/** The currently open session id (undefined only in the no-session view). */
	current?: string;
}

export type UseSessions = <T>(selector: (session: SessionSummary | undefined) => T) => T;

/** Snapshot selector over the workspace list (the standard useWorkspaces hook). */
export type UseWorkspaces = <T>(selector: (snapshot: { items?: Array<{ workspaceId?: string; path?: string; sessionIds?: readonly string[] }> }) => T) => T;

export interface SlotsCtx {
	slots: {
		inject(slot: string, register: () => unknown): unknown;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			component: unknown,
		): unknown;
	};
}

export interface SessionRow {
	id?: string;
	displayTitle?: string;
	title?: string;
	cwd?: string;
	parentId?: string;
	origin?: string;
	blank?: boolean;
	updatedAt?: number;
}

export interface SessionsService {
	list: { getSnapshot(): { byId?: Record<string, SessionRow> } };
	open(id: string): void;
}

export interface UiWorkspaceService {
	connectWorkspace(workspaceId: string): Promise<string>;
}

export interface ConversationService {
	input: { shell(id: string): { setDraft(text: string): void } };
}

export interface FileRefCandidate {
	path?: string;
	kind?: string;
}

export interface RemoteService {
	fileReferences: {
		list(sessionId: string, query: string, signal: AbortSignal): Promise<{ ok?: boolean; value?: FileRefCandidate[] }>;
	};
}

/** Harness client services captured by the apply closure for the view. */
export interface PipelineServices {
	sessions?: SessionsService;
	uiWorkspace?: UiWorkspaceService;
	conversation?: ConversationService;
	remote?: RemoteService;
}

/** The plugin ctx slice the client entry reads (services are optional — the
 * guard allowlist resolves them, but code probes before use). */
export interface PipelineCtx extends SlotsCtx {
	sessions?: SessionsService;
	uiWorkspace?: UiWorkspaceService;
	conversation?: ConversationService;
	remote?: RemoteService;
}

/** A workspace session offered as a "Send to session…" target. */
export interface SessionTarget {
	id: string;
	label: string;
}

/** Numeric tail of an id (`agent-12` → 12), used to restore the id counter. */
export function numericSuffix(value: unknown): number {
	const m = /(\d+)$/.exec(String(value));
	return m ? parseInt(m[1], 10) : 0;
}

/** Resolve a (possibly workspace-relative) path to the absolute form the agent reads. */
export function absolutePath(path: string, cwd: string | undefined): string {
	if (path.startsWith("/")) return path;
	const base = typeof cwd === "string" && cwd.length > 0 ? cwd.replace(/\/+$/, "") : "";
	return base.length > 0 ? base + "/" + path : path;
}

/** Serialize the internal graph to the wire/persisted shape (matches the View JSON contract). */
export function buildGraph(agents: CanvasAgent[], connections: CanvasConnection[]): PipelineGraph {
	return {
		agents: agents.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description || "",
			instructions: a.instructions || "",
			...(typeof a.systemPrompt === "string" && a.systemPrompt.trim().length > 0 ? { systemPrompt: a.systemPrompt } : {}),
			x: Math.round(a.x),
			y: Math.round(a.y),
			input: a.id + ":in",
			output: a.id + ":out",
			...(a.settings ? { settings: a.settings } : {}),
		})),
		connections: connections.map((c) => ({
			id: c.id,
			source: c.source,
			target: c.target,
			sourcePort: c.source + ":out",
			targetPort: c.target + ":in",
		})),
	};
}

/**
 * Read one persisted agent back into React state: the first-class
 * `systemPrompt` plus the settings. Legacy on-disk shapes are lifted so older
 * pipeline.json files lose nothing: `settings` was named `overrides`, the
 * system prompt was the top-level `persona` and before that
 * `overrides.persona`. Object-shaped setting values round-trip untouched (a
 * hand-edited file must not lose data); the edit form canonicalizes a shape
 * only when that agent is saved again.
 */
export function loadAgent(raw: unknown): { systemPrompt: string; settings?: AgentSettings } {
	const rawAgent = (raw ?? {}) as Record<string, unknown>;
	const rawSettings = loadSettingsShape(rawAgent.settings !== undefined ? rawAgent.settings : rawAgent.overrides);
	const legacySettingsPersona = rawSettings?.persona;
	const settings = legacySettingsPersona === undefined ? rawSettings : (() => {
		const rest = { ...rawSettings };
		delete rest.persona;
		return Object.keys(rest).length > 0 ? rest : undefined;
	})();
	const systemPrompt =
		typeof rawAgent.systemPrompt === "string" && rawAgent.systemPrompt.length > 0
			? rawAgent.systemPrompt
			: typeof rawAgent.persona === "string" && rawAgent.persona.length > 0
				? rawAgent.persona
				: typeof legacySettingsPersona === "string"
					? legacySettingsPersona
					: "";
	return { systemPrompt, settings };
}

function loadSettingsShape(raw: unknown): (AgentSettings & { persona?: string }) | undefined {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: AgentSettings & { persona?: string } = {};
	// Legacy field: read only so it can be lifted; never written back.
	if (typeof r.persona === "string" && r.persona.length > 0) out.persona = r.persona;
	if (typeof r.maxDepth === "number" && Number.isFinite(r.maxDepth)) out.maxDepth = r.maxDepth;
	if (r.agentOptions != null && typeof r.agentOptions === "object" && !Array.isArray(r.agentOptions)) {
		out.agentOptions = r.agentOptions as AgentSettings["agentOptions"];
	}
	if (r.toolFilter != null && typeof r.toolFilter === "object" && !Array.isArray(r.toolFilter)) {
		out.toolFilter = r.toolFilter as AgentSettings["toolFilter"];
	}
	if (r.outputSchema !== undefined && r.outputSchema !== null) out.outputSchema = r.outputSchema;
	return Object.keys(out).length > 0 ? out : undefined;
}
