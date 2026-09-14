// Shared primitives for the pipeline client components: module constants,
// the structural views of the harness client services (same discipline as the
// Host half — only the fields the client calls), the internal canvas state
// shapes, and the graph serialization helpers. No React here — components
// import react themselves.
//
// Every service the client touches must stay on the module entry's `inject`
// (src/client.tsx): the dynamic ctx proxy rejects property reads of undeclared
// services, and nested Remote namespaces need their own dotted entry.

import type { AgentSettings, Connection, ControlNode, IfBranch, InputPortSpec, OutputBinding, PipelineGraph, PortSide, RunFiring } from "../types.ts";
import { branchRows } from "../controls.ts";

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
	/**
	 * Declared port lists, carried through untouched. Authored in the agent
	 * config panel's ports editor (P7); a hand-edited pipeline.json must
	 * survive a load-and-save round trip without losing data — the same rule
	 * loadAgent applies to settings shapes.
	 */
	inputPorts?: InputPortSpec[];
	outputPorts?: string[];
	/**
	 * The node edge each named output port renders on (see PortSide in
	 * types.ts), keyed by port name; absent entry = "right". Purely
	 * presentational — the executor never reads it.
	 */
	outputPortSides?: Record<string, PortSide>;
	/**
	 * Output-port bindings (selective emission): `field == value → port`,
	 * first match wins, no `value` = catch-all. See OutputBinding in types.ts.
	 */
	bindings?: OutputBinding[];
	/** The agent's settings (see AgentSettings); absent fields inherit defaults. */
	settings?: AgentSettings;
	/** Pause-on-output breakpoint: the run parks after this agent settles. */
	breakpoint?: boolean;
}

/**
 * A control node as held in React state — the canvas twin of ControlNode
 * (types.ts), with the branch sides included (each branch tick renders on its
 * declared node edge). `kind` is held as a plain string so a hand-edited file
 * carrying a future control kind round-trips untouched: the canvas renders
 * branch ticks only for "if" and the graph contract treats other kinds as
 * plain endpoints (validateControls), so nothing is lost across a
 * load-and-save.
 */
export interface CanvasControl {
	id: string;
	/**
	 * Custom display name; absent means the canvas shows the kind ("if").
	 * Purely presentational — ids stay the identity the executor, validation,
	 * and wire ids address.
	 */
	name?: string;
	kind: string;
	branches: IfBranch[];
	x: number;
	y: number;
}

/**
 * A connection as held in React state. The ports are PORT NAMES (not wire
 * ids), defaulting to "out"/"in" — buildGraph composes the wire ids
 * `<agentId>:<name>` the graph and kernel resolve against. Undeclared port
 * names on an agent mean its single default port. Control endpoints break the
 * default composition: a control-sourced edge's sourcePort is the BRANCH name
 * (always serialized as `<controlId>:<branch>`), and a control-targeted edge
 * serializes with NO targetPort — the control takes a single unnamed input.
 */
export interface CanvasConnection {
	id: string;
	source: string;
	target: string;
	/** The source agent's output PORT NAME this edge leaves (default "out"). */
	sourcePort?: string;
	/** The target agent's input PORT NAME this edge enters (default "in"). */
	targetPort?: string;
}

/** The run-result object returned by the Host's /run route. */
export interface RunResultLike {
	ok?: boolean;
	outputs?: Record<string, unknown>;
	runs?: Array<{ id: string; label?: string; status?: string; error?: string; childSessionId?: string }>;
	error?: string;
	validationErrors?: Array<{ message?: string }>;
	/** The durable run ended because the user aborted it. */
	aborted?: boolean;
}

// ---- Durable run state (mirrors the Host's RunRecord; type-only import) ----

/**
 * A LEGACY v1 record's per-node status slot (the pre-firing-log shape). The
 * v2 record carries no such slots — its `nodes` map is executor control state
 * only — so live rendering always goes through projectNodes (../projection.ts).
 */
export interface RunNodeStateLike {
	status?: "pending" | "running" | "done" | "paused" | "aborted" | "error";
	input?: string;
	output?: string;
	error?: string;
	stopReason?: string;
	childSessionId?: string;
}

/** The run record the browser follows over SSE (mirrors the Host's RunRecord; legacy v1 records render read-only). */
export interface RunRecordLike {
	runId?: string;
	cwd?: string;
	sessionId?: string;
	/** 2 = the firing log. Absent on legacy v1 records (order + nodes slots). */
	recordVersion?: number;
	createdAt?: string;
	updatedAt?: string;
	state?: "running" | "paused" | "completed" | "aborted" | "error";
	/** The paused FIRING id on v2 (a node id on v1); the node comes from the projection. */
	pausedAt?: string;
	graph?: PipelineGraph;
	input?: unknown;
	maxInFlight?: number;
	/** v2: the firing log — one entry per firing (see RunFiring). */
	firings?: RunFiring[];
	/** v1 only: the walk order. */
	order?: string[];
	/** v1: per-node status slots; v2: executor control state (each continuable
	 * node's parent anchor session id). The UI renders from the projection. */
	nodes?: Record<string, RunNodeStateLike>;
	/** Bound-overflow record (design principle 4). Reserved. */
	dropped?: Array<{ nodeId: string; port: string; from: string }>;
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

/**
 * Serialize the internal graph to the wire/persisted shape (matches the View JSON contract).
 * `controls` is optional so legacy callers keep composing exactly today's
 * graph — with no controls (or an empty list) the `controls` key is omitted
 * and the output is byte-identical to the pre-control shape (additive schema).
 * Control endpoints serialize by their own rules: a control-sourced connection
 * always carries the branch name as `sourcePort`, and a control-targeted one
 * carries NO `targetPort` (the unconditional ":in" composition would fail the
 * control's single-unnamed-input rule).
 */
export function buildGraph(agents: CanvasAgent[], connections: CanvasConnection[], controls: CanvasControl[] = []): PipelineGraph {
	const controlIds = new Set(controls.map((k) => k.id));
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
			// Declared port lists pass through verbatim (they supersede the legacy
			// input/output strings during validation and execution).
			...(a.inputPorts !== undefined ? { inputPorts: a.inputPorts } : {}),
			...(a.outputPorts !== undefined ? { outputPorts: a.outputPorts } : {}),
			...(a.outputPortSides !== undefined && Object.keys(a.outputPortSides).length > 0 ? { outputPortSides: a.outputPortSides } : {}),
			...(a.bindings !== undefined ? { bindings: a.bindings } : {}),
			...(a.settings ? { settings: a.settings } : {}),
			...(a.breakpoint === true ? { breakpoint: true } : {}),
		})),
		connections: connections.map((c) => ({
			id: c.id,
			source: c.source,
			target: c.target,
			// Wire ids compose from the PORT NAMES (default out/in — byte-identical
			// to the historical shape on default graphs). A control source writes
			// its BRANCH name even at the state default, so the branch is always
			// named; a control target omits the key entirely — the pinned honest
			// shape (a control takes a single unnamed input), read back as
			// unknown by the graph contract, hence the cast.
			sourcePort: c.source + ":" + (c.sourcePort ?? "out"),
			...(controlIds.has(c.target) ? {} : { targetPort: c.target + ":" + (c.targetPort ?? "in") }),
		})) as Connection[],
		// Branch rules serialize minimal, through the one row reader: a branch
		// with no rows stays bare `{ name }` (the catch-all), a SINGLE row
		// serializes the legacy flat keys (field/value/op) so one-condition
		// graphs stay byte-identical to the pre-conditions shape, and a
		// multi-condition gate serializes `conditions` (no flat keys beside
		// it). Within a row an empty field/value pair drops both keys (a
		// catch-all row), a default side drops `side`, and a `==` op drops
		// `op` (present only when ">=") — the same non-default-sides-only
		// convention the port editor uses.
		...(controls.length > 0 ? {
			controls: controls.map((k) => ({
				id: k.id,
				// The display name serializes only when authored (non-empty) — the
				// same non-default-sides-only convention the branches use.
				...(typeof k.name === "string" && k.name.length > 0 ? { name: k.name } : {}),
				kind: k.kind,
				branches: k.branches.map((b) => {
					const side = b.side !== undefined && b.side !== "right" ? { side: b.side } : {};
					const rows = branchRows(b).map((row) => ({
						...(typeof row.field === "string" && row.field.length > 0 ? { field: row.field } : {}),
						...(row.value !== undefined && row.value !== "" ? { value: row.value } : {}),
						...(row.op === ">=" ? { op: row.op } : {}),
					}));
					if (rows.length === 0) return { name: b.name, ...side };
					if (rows.length === 1) return { name: b.name, ...rows[0], ...side };
					return { name: b.name, conditions: rows, ...side };
				}) as IfBranch[],
				x: Math.round(k.x),
				y: Math.round(k.y),
			})) as ControlNode[],
		} : {}),
	};
}

/**
 * Read one persisted agent back into React state: the first-class
 * `systemPrompt`, the settings, the declared port lists, and the output
 * bindings. Legacy on-disk shapes are lifted so older pipeline.json files lose
 * nothing: `settings` was named `overrides`, the system prompt was the
 * top-level `persona` and before that `overrides.persona`. Object-shaped
 * setting values, the port lists, and the bindings round-trip untouched (a
 * hand-edited file must not lose data); the edit form canonicalizes a shape
 * only when that agent is saved again.
 */
export function loadAgent(raw: unknown): {
	systemPrompt: string;
	settings?: AgentSettings;
	breakpoint?: boolean;
	inputPorts?: InputPortSpec[];
	outputPorts?: string[];
	outputPortSides?: Record<string, PortSide>;
	bindings?: OutputBinding[];
} {
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
	const breakpoint = rawAgent.breakpoint === true;
	// Declared port lists and bindings round-trip untouched (see CanvasAgent):
	// a hand-written file must not lose them.
	const inputPorts = Array.isArray(rawAgent.inputPorts) ? (rawAgent.inputPorts as InputPortSpec[]) : undefined;
	const outputPorts = Array.isArray(rawAgent.outputPorts) ? (rawAgent.outputPorts as string[]) : undefined;
	const outputPortSides = rawAgent.outputPortSides != null && typeof rawAgent.outputPortSides === "object" && !Array.isArray(rawAgent.outputPortSides)
		? (rawAgent.outputPortSides as Record<string, PortSide>)
		: undefined;
	const bindings = Array.isArray(rawAgent.bindings) ? (rawAgent.bindings as OutputBinding[]) : undefined;
	return {
		systemPrompt,
		settings,
		...(breakpoint ? { breakpoint: true } : {}),
		...(inputPorts !== undefined ? { inputPorts } : {}),
		...(outputPorts !== undefined ? { outputPorts } : {}),
		...(outputPortSides !== undefined ? { outputPortSides } : {}),
		...(bindings !== undefined ? { bindings } : {}),
	};
}

/**
 * Read the persisted controls back into React state: object entries with a
 * non-empty id survive, branches normalize through the one row reader
 * (branchRows) to the canonical state shape — a bare `{ name }` catch-all, a
 * single-row branch in the legacy flat keys (a missing field becomes "", an
 * unknown side or op falls back to the default), and a multi-condition gate
 * as `conditions` — so the canvas state is always clean and the next save
 * re-serializes it minimally. Malformed entries are skipped — validation
 * reports the skipped control and branch entries from the persisted file
 * (junk rows INSIDE a `conditions` list are the exception: branchRows drops
 * them silently, so they vanish at the next save with no finding), and the
 * next save canonicalizes the graph to what the canvas holds.
 */
export function loadControls(raw: unknown): CanvasControl[] {
	if (!Array.isArray(raw)) return [];
	const out: CanvasControl[] = [];
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as { id?: unknown; name?: unknown; kind?: unknown; branches?: unknown; x?: unknown; y?: unknown };
		const id = rec.id == null ? "" : String(rec.id);
		if (id.length === 0) continue;
		const branches = Array.isArray(rec.branches) ? rec.branches.map((b: unknown): IfBranch | null => {
			if (b == null || typeof b !== "object" || Array.isArray(b)) return null;
			const br = b as { name?: unknown; side?: unknown };
			const side = br.side === "left" || br.side === "right" || br.side === "top" || br.side === "bottom"
				? br.side as PortSide
				: undefined;
			// Each condition row normalizes like the flat form always has: the
			// field to a string ("" when missing), the value stringified when
			// present ("" stays — the editor's catch-all), and only ">="
			// survives as the op (an unknown op is validation's finding from
			// the file; the next save canonicalizes the graph to what the
			// canvas holds).
			const rows = branchRows(b).map((row) => ({
				field: typeof row.field === "string" ? row.field : "",
				...(row.value === undefined ? {} : { value: String(row.value) }),
				...(row.op === ">=" ? { op: ">=" as const } : {}),
			}));
			const base = { name: br.name == null ? "" : String(br.name), ...(side !== undefined ? { side } : {}) };
			if (rows.length === 0) return base;
			if (rows.length === 1) return { ...base, ...rows[0] };
			return { ...base, conditions: rows };
		}).filter((b): b is IfBranch => b !== null) : [];
		out.push({
			id,
			...(typeof rec.name === "string" && rec.name.length > 0 ? { name: rec.name } : {}),
			kind: rec.kind == null ? "if" : String(rec.kind),
			branches,
			x: Number(rec.x) || 0,
			y: Number(rec.y) || 0,
		});
	}
	return out;
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
