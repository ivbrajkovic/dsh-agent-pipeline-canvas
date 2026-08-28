// dsh-agent-pipeline-canvas — browser half.
//
// A TypeScript module bundled into lib/client.js by tsdown (the
// window.__ModuleLoader__.load({ id, factory }) format the browser module
// system consumes). Because tsdown bundles the client from this source tree,
// it can import the canonical validateGraph from ./graph.ts and the shared
// contract types from ./types.ts — the Hand-written duplication of the
// validation logic is GONE. Pure type shapes are type-only imports (erased
// before the bundle is built), so the browser's module-table require() only
// ever answers the real externally-requested `react` row.
//
// It registers a "Pipelines" view tab into `conversation.view` (additive,
// replaceRisk: none, order 30) so the canvas is available in EVERY session.
// Because the harness hides the whole session body (tabs included) while a
// session is blank, two more root-scope seats make the canvas reachable from
// a brand-new session too: a "Pipelines" trigger row in `sidebar.footer.action`
// and a frame-wide panel in `shell.overlay` bound to the CURRENT session.
// The view renders the whole node workspace: a palette with a draggable Agent,
// a canvas, node move/select, and output→input connections with directed edges.
//
// Running: the Run button opens an INPUT MODAL (multiline text + workspace
// files attached as ABSOLUTE PATHS via the harness `@`-mention file-reference
// completion or manual entry; contents are never inlined — the first agent
// reads them with its own tools). On completion a RESULT MODAL offers the
// continue routes: "Continue in chat" prefills this session's composer via the
// standard `inputActions` and opens the chat view; "Continue in a new session"
// creates/opens a workspace session; "Send to session…" prefills another
// session's composer by id. Nothing ever auto-sends — every route stages the
// text and the user presses send.
//
// Persistence: the graph is backed by the project's `.agent-pipeline/pipeline.json`
// (written by the Host half via the `/dsh-agent-pipeline` route). The view
// recovers the session's workspace root (cwd) from the framework standard kit
// (`useSessions`), loads the saved graph on mount, and persists the graph after
// every structural change (add / delete / clear / connect / move). Because the
// view-ring slot only mounts the active tab, switching away would otherwise
// discard the React-local state — persisting to disk makes the pipeline survive
// tab switches, UI reloads, and reopen. If no cwd is known yet, the canvas
// still works in-memory and quietly awaits load/save.

import * as React from "react";
import { validateGraph } from "./graph.ts";
import { composePipelineInput, finalOutputText } from "./message.ts";
import type { PipelineGraph, ValidationResult } from "./types.ts";

const CSS_TAG = "dsh-agent-pipeline-canvas/styles";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-agent-pipeline-canvas";
	tag.dataset.pluginCss = CSS_TAG;
	tag.textContent = [
		".pipeline-view{position:relative;display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;font-family:inherit;color:var(--dsw-alias-label-primary)}",
		".pipeline-view .pipeline-toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1)}",
		".pipeline-view .pipeline-toolbar h3{margin:0;font-size:14px;font-weight:600}",
		".pipeline-view .pipeline-toolbar .spacer{flex:1}",
		".pipeline-view .pipeline-toolbar .stat{font-size:12px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-view .pipeline-toolbar .pipeline-validation{margin-left:6px;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);line-height:1}",
		".pipeline-view .pipeline-toolbar .pipeline-validation.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}",
		".pipeline-view .pipeline-toolbar .pipeline-validation.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}",
		".pipeline-issues{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,var(--dsw-alias-border-l1));padding:6px 10px;max-height:120px;overflow:auto;display:flex;flex-direction:column;gap:3px}",
		".pipeline-issue{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.4}",
		".pipeline-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px}",
		".pipeline-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-btn:disabled{opacity:.5;cursor:default}",
		".pipeline-body{flex:1;min-height:0;display:flex;border-top:1px solid var(--dsw-alias-border-l1)}",
		".pipeline-palette{width:170px;flex-shrink:0;background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l1);padding:12px;box-sizing:border-box;overflow:auto}",
		".pipeline-palette .palette-title{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin-bottom:10px}",
		".palette-item{display:flex;align-items:center;gap:8px;cursor:grab;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;padding:10px;font-size:13px;user-select:none}",
		".palette-item:active{cursor:grabbing}",
		".palette-icon{width:12px;height:12px;border-radius:3px;background:var(--dsw-alias-brand-primary)}",
		".pipeline-canvas{position:relative;flex:1;min-height:0;overflow:hidden;background-image:radial-gradient(circle,rgba(128,128,128,.18) 1px,transparent 1px);background-size:20px 20px}",
		".pipeline-canvas:focus{outline:none}",
		".pipeline-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;pointer-events:none;text-align:center;padding:0 20px}",
		".pipeline-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}",
		".pipeline-edge{stroke:var(--dsw-alias-label-secondary);stroke-width:2;fill:none}",
		".pipeline-arrowfill{fill:var(--dsw-alias-label-secondary)}",
		".pipeline-edge-temp{stroke:var(--dsw-alias-brand-primary);stroke-width:2;fill:none;stroke-dasharray:6 4}",
		".pipeline-node{position:absolute;width:150px;height:58px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1.5px solid var(--dsw-alias-border-l2);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:move;user-select:none}",
		".pipeline-node.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}",
		".pipeline-node .node-name{font-size:13px;font-weight:600}",
		".pipeline-node .node-sub{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px}",
		".pipeline-port{position:absolute;top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-overlay);border:2px solid var(--dsw-alias-brand-primary);cursor:crosshair}",
		".pipeline-port.in{left:-8px}",
		".pipeline-port.out{right:-8px;border-color:var(--dsw-alias-state-success-primary)}",
		".pipeline-port.hover{box-shadow:0 0 0 4px var(--dsw-alias-brand-primary)}",
		".pipeline-json{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}",
		".pipeline-json pre{margin:0;padding:10px;max-height:200px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-word}",
		".pipeline-config-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
		".pipeline-modal-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
		".pipeline-config{width:380px;max-width:92%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)}",
		".pipeline-config h3{margin:0;font-size:14px;font-weight:600}",
		".pipeline-config .config-row{display:flex;flex-direction:column;gap:4px}",
		".pipeline-config label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-config input,.pipeline-config textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
		".pipeline-config input:focus,.pipeline-config textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-config textarea{min-height:72px;resize:vertical}",
		".pipeline-config .config-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
		".pipeline-btn-run{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
		".pipeline-btn-run:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
		".pipeline-modal{width:560px;max-width:94%;max-height:88%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:auto}",
		".pipeline-modal h3{margin:0;font-size:14px;font-weight:600}",
		".pipeline-modal .modal-row{display:flex;flex-direction:column;gap:4px}",
		".pipeline-modal label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-modal textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%;min-height:96px;resize:vertical}",
		".pipeline-modal input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
		".pipeline-modal textarea:focus,.pipeline-modal input:focus,.pipeline-modal select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-modal select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;box-sizing:border-box;width:100%}",
		".pipeline-attach-zone{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}",
		".pipeline-attach-zone.drag{border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-chips{display:flex;flex-wrap:wrap;gap:6px}",
		".pipeline-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 4px 2px 9px;max-width:100%}",
		".pipeline-chip .chip-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}",
		".pipeline-chip .chip-x{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:2px 6px;border-radius:999px}",
		".pipeline-chip .chip-x:hover{color:var(--dsw-alias-state-error-primary)}",
		".pipeline-picker-list{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);max-height:150px;overflow:auto;display:flex;flex-direction:column}",
		".pipeline-picker-row{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;cursor:pointer;user-select:none}",
		".pipeline-picker-row:hover{background:var(--dsw-alias-bg-layer-2)}",
		".pipeline-picker-row .row-kind{flex-shrink:0;font-size:10px;color:var(--dsw-alias-label-secondary);width:52px}",
		".pipeline-picker-row .row-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".pipeline-picker-row .row-add{flex-shrink:0;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:4px;font-size:11px;line-height:1;padding:2px 6px;cursor:pointer}",
		".pipeline-picker-row .row-add:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-picker-status{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-modal-notice{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
		".pipeline-modal-status{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
		".pipeline-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;align-items:center}",
		".pipeline-modal-actions .spacer{flex:1}",
		".pipeline-result{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
		".pipeline-result-row{display:flex;flex-direction:column;gap:2px}",
		".pipeline-result-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-result-value{margin:0;padding:6px 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
		".pipeline-result-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
		".pipeline-result-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
		".pipeline-trigger{position:relative;flex:none;display:flex;align-items:center;width:100%;height:42px;margin:8px 0 0}",
		".pipeline-trigger-btn{display:inline-flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;cursor:pointer;overflow:hidden}",
		".pipeline-trigger-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		".pipeline-trigger.rail{width:36px;height:36px;margin:0}",
		".pipeline-trigger.rail .pipeline-trigger-btn{justify-content:center;gap:0;width:36px;height:36px;padding:0;border-radius:50%}",
		".pipeline-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".pipeline-shell-backdrop{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.5)}",
		".pipeline-shell{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:41;width:min(1200px,94vw);height:min(860px,90vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:hidden}",
		".pipeline-shell-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}",
		".pipeline-shell-head h4{margin:0;font-size:13px;font-weight:600}",
		".pipeline-shell-cwd{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}",
		".pipeline-shell-head .spacer{flex:1}",
		".pipeline-shell .pipeline-view{flex:1;min-height:0;height:auto}",
		".pipeline-shell-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;padding:0 24px;text-align:center}",
	].join("");
	document.head.appendChild(tag);
}

const ENDPOINT = "/dsh-agent-pipeline";
const SAVE_DEBOUNCE_MS = 250;

/** Stable empty selector results (identity matters to the snapshot hooks). */
const EMPTY_ROWS: Record<string, SessionRow> = {};
const EMPTY_ITEMS: Array<{ workspaceId?: string; path?: string; sessionIds?: readonly string[] }> = [];

// ---- Internal canvas state shapes ----

/** An agent node as held in React state (no wire ports; buildGraph adds them). */
interface CanvasAgent {
	id: string;
	name: string;
	description: string;
	instructions: string;
	x: number;
	y: number;
}

/** A connection as held in React state (ports derived from source/target). */
interface CanvasConnection {
	id: string;
	source: string;
	target: string;
}

/** The run-result object returned by the Host's /run route. */
interface RunResultLike {
	ok?: boolean;
	outputs?: Record<string, unknown>;
	runs?: Array<{ id: string; label?: string; status?: string; error?: string }>;
	error?: string;
	validationErrors?: Array<{ message?: string }>;
}

/** The useSessions feed: session list rows plus the current selection. */
interface SessionSummary {
	byId?: Record<string, SessionRow>;
	/** The currently open session id (undefined only in the no-session view). */
	current?: string;
}

type UseSessions = <T>(selector: (session: SessionSummary | undefined) => T) => T;

interface SlotsCtx {
	slots: {
		inject(slot: string, register: () => unknown): unknown;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			component: unknown,
		): unknown;
	};
}

// ---- Minimal structural views of the harness services the continue routes touch ----
// Same discipline as RunnerContext/HostContext: only the fields the client
// calls, never the full Cordis types. The real client services satisfy these
// shapes structurally (sessions: ISessions; uiWorkspace: UiWorkspace;
// conversation: ConversationController; remote: generated Remote namespaces).

interface SessionRow {
	id?: string;
	displayTitle?: string;
	title?: string;
	cwd?: string;
	parentId?: string;
	origin?: string;
	blank?: boolean;
	updatedAt?: number;
}

interface SessionsService {
	list: { getSnapshot(): { byId?: Record<string, SessionRow> } };
	open(id: string): void;
	create(opts: { cwd?: string; workspaceId?: string }): Promise<string>;
}

interface UiWorkspaceService {
	connectWorkspace(workspaceId: string): Promise<string>;
}

interface ConversationService {
	input: { shell(id: string): { setDraft(text: string): void } };
}

interface FileRefCandidate {
	path?: string;
	kind?: string;
}

interface RemoteService {
	fileReferences: {
		list(sessionId: string, query: string, signal: AbortSignal): Promise<{ ok?: boolean; value?: FileRefCandidate[] }>;
	};
}

/** Harness client services captured by the apply closure for the view. */
interface PipelineServices {
	sessions?: SessionsService;
	uiWorkspace?: UiWorkspaceService;
	conversation?: ConversationService;
	remote?: RemoteService;
}

/** A workspace session offered as a "Send to session…" target. */
interface SessionTarget {
	id: string;
	label: string;
}

/** Numeric tail of an id (`agent-12` → 12), used to restore the id counter. */
function numericSuffix(value: unknown): number {
	const m = /(\d+)$/.exec(String(value));
	return m ? parseInt(m[1], 10) : 0;
}

/** Serialize the internal graph to the wire/persisted shape (matches the View JSON contract). */
function buildGraph(agents: CanvasAgent[], connections: CanvasConnection[]): PipelineGraph {
	return {
		agents: agents.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description || "",
			instructions: a.instructions || "",
			x: Math.round(a.x),
			y: Math.round(a.y),
			input: a.id + ":in",
			output: a.id + ":out",
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

// Editable configuration for a single agent: name / description /
// instructions. Rendered in a modal overlay when an agent is double-clicked;
// local state is seeded from the agent on mount (the component is keyed by the
// agent id, so opening a different agent remounts it cleanly). Saving mutates
// the agent in the graph and lets the debounced persist write it back to
// pipeline.json.
function AgentConfigPanel({ agent, onSave, onClose }: {
	agent: CanvasAgent;
	onSave: (updated: { id: string; name: string; description: string; instructions: string }) => void;
	onClose: () => void;
}) {
	const [name, setName] = React.useState(agent.name);
	const [description, setDescription] = React.useState(agent.description);
	const [instructions, setInstructions] = React.useState(agent.instructions);
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	return React.createElement(
		"div",
		{ className: "pipeline-config-overlay", onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); } },
		React.createElement(
			"div",
			{ className: "pipeline-config" },
			React.createElement("h3", null, "Configure Agent"),
			React.createElement("div", { className: "config-row" },
				React.createElement("label", null, "Name"),
				React.createElement("input", { value: name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); }, onKeyDown: stopKey })
			),
			React.createElement("div", { className: "config-row" },
				React.createElement("label", null, "Description"),
				React.createElement("input", { value: description, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setDescription(e.target.value); }, onKeyDown: stopKey })
			),
			React.createElement("div", { className: "config-row" },
				React.createElement("label", null, "Instructions"),
				React.createElement("textarea", { value: instructions, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInstructions(e.target.value); }, onKeyDown: stopKey })
			),
			React.createElement("div", { className: "config-actions" },
				React.createElement("button", { className: "pipeline-btn", onClick: onClose }, "Cancel"),
				React.createElement("button", { className: "pipeline-btn", onClick: () => {
					onSave({ id: agent.id, name, description, instructions });
				} }, "Save")
			)
		)
	);
}

/** Resolve a (possibly workspace-relative) path to the absolute form the agent reads. */
function absolutePath(path: string, cwd: string | undefined): string {
	if (path.startsWith("/")) return path;
	const base = typeof cwd === "string" && cwd.length > 0 ? cwd.replace(/\/+$/, "") : "";
	return base.length > 0 ? base + "/" + path : path;
}

// The Run modal: multiline pipeline input plus workspace files attached as
// ABSOLUTE PATHS. Files are never inlined — the first agent reads them with
// its own tools. The picker rides the harness's own `@`-mention file-reference
// completion (`remote.fileReferences.list`): type a path prefix, click a file
// to attach it, click a directory to descend. OS drag-and-drop of files
// cannot yield absolute paths in a browser, so a dropped file shows a notice;
// dropped plain-text paths are attached.
function RunModal({ cwd, initialText, initialFiles, running, fileList, onRun, onClose }: {
	cwd?: string;
	initialText: string;
	initialFiles: string[];
	running: boolean;
	fileList: ((query: string, signal: AbortSignal) => Promise<FileRefCandidate[]>) | null;
	onRun: (text: string, files: string[]) => void;
	onClose: () => void;
}) {
	const [text, setText] = React.useState(initialText);
	const [files, setFiles] = React.useState<string[]>(initialFiles);
	const [query, setQuery] = React.useState("");
	const [candidates, setCandidates] = React.useState<FileRefCandidate[]>([]);
	const [pickerState, setPickerState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
	const [manual, setManual] = React.useState("");
	const [notice, setNotice] = React.useState<string | null>(null);
	const [dragOver, setDragOver] = React.useState(false);
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	function attach(path: string) {
		const abs = absolutePath(path.trim(), cwd);
		if (abs.length === 0) return;
		setFiles((prev) => (prev.indexOf(abs) === -1 ? prev.concat([abs]) : prev));
	}
	function onPickRow(candidate: FileRefCandidate, add: boolean) {
		const path = typeof candidate.path === "string" ? candidate.path : "";
		if (path.length === 0) return;
		if (add || candidate.kind !== "directory") attach(path);
		else setQuery(path + "/");
	}
	function onDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);
		const text = e.dataTransfer.getData("text/plain");
		if (typeof text === "string" && text.trim().startsWith("/")) {
			text.split("\n").forEach((line) => { if (line.trim().startsWith("/")) attach(line); });
			return;
		}
		if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
			setNotice("The browser hides dropped files' paths — use the picker below (or paste a path).");
		}
	}
	// Debounced completion query against the file-reference source.
	React.useEffect(() => {
		if (fileList === null) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			setPickerState("loading");
			fileList(query, controller.signal)
				.then((rows) => {
					if (controller.signal.aborted) return;
					setCandidates(rows.filter((c) => c && typeof c.path === "string" && c.path.length > 0));
					setPickerState("ready");
				})
				.catch(() => {
					if (controller.signal.aborted) return;
					setCandidates([]);
					setPickerState("error");
				});
		}, 150);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [query, fileList]);
	return React.createElement(
		"div",
		{
			className: "pipeline-modal-overlay",
			onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); },
		},
		React.createElement(
			"div",
			{ className: "pipeline-modal" },
			React.createElement("h3", null, "Run Pipeline"),
			React.createElement("div", { className: "modal-row" },
				React.createElement("label", null, "Input (the first agent receives this)"),
				React.createElement("textarea", {
					value: text,
					placeholder: "What should the pipeline do?",
					onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setText(e.target.value); },
					onKeyDown: stopKey,
				})
			),
			React.createElement(
				"div",
				{
					className: "pipeline-attach-zone" + (dragOver ? " drag" : ""),
					onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
					onDragLeave: () => { setDragOver(false); },
					onDrop,
				},
				files.length > 0 ? React.createElement("div", { className: "pipeline-chips" },
					files.map((f) => React.createElement("span", { key: f, className: "pipeline-chip", title: f },
						React.createElement("span", { className: "chip-path" }, f),
						React.createElement("button", {
							className: "chip-x",
							title: "Remove",
							onClick: () => { setFiles((prev) => prev.filter((p) => p !== f)); },
						}, "×")
					))
				) : React.createElement("div", { className: "pipeline-picker-status" }, "No files attached."),
				fileList !== null ? React.createElement("input", {
					value: query,
					placeholder: "Attach workspace files — type a path to search…",
					onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value); },
					onKeyDown: stopKey,
				}) : null,
				fileList !== null && (pickerState !== "idle" || query.length > 0) ? React.createElement(
					"div",
					{ className: "pipeline-picker-list" },
					pickerState === "loading" ? React.createElement("div", { className: "pipeline-picker-row" }, React.createElement("span", { className: "pipeline-picker-status" }, "Searching…")) : null,
					pickerState === "error" ? React.createElement("div", { className: "pipeline-picker-row" }, React.createElement("span", { className: "pipeline-picker-status" }, "File search unavailable.")) : null,
					pickerState === "ready" && candidates.length === 0 ? React.createElement("div", { className: "pipeline-picker-row" }, React.createElement("span", { className: "pipeline-picker-status" }, "No matches.")) : null,
					candidates.map((c) => React.createElement("div", {
						key: c.path,
						className: "pipeline-picker-row",
						onClick: () => { onPickRow(c, false); },
					},
						React.createElement("span", { className: "row-kind" }, c.kind === "directory" ? "dir" : "file"),
						React.createElement("span", { className: "row-path", title: c.path }, c.path),
						React.createElement("button", {
							className: "row-add",
							title: "Attach",
							onClick: (e: React.MouseEvent) => { e.stopPropagation(); onPickRow(c, true); },
						}, "+ attach")
					))
				) : null,
				React.createElement("div", { className: "pipeline-chips" },
					React.createElement("input", {
						value: manual,
						placeholder: "…or paste an absolute path",
						style: { flex: "1 1 200px", width: "auto" },
						onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setManual(e.target.value); },
						onKeyDown: (e: React.KeyboardEvent) => {
							e.stopPropagation();
							if (e.key === "Enter") { attach(manual); setManual(""); }
							if (e.key === "Escape") onClose();
						},
					}),
					React.createElement("button", {
						className: "pipeline-btn",
						disabled: manual.trim().length === 0,
						onClick: () => { attach(manual); setManual(""); },
					}, "Add")
				),
				notice ? React.createElement("div", { className: "pipeline-modal-notice" }, notice) : null
			),
			React.createElement("div", { className: "pipeline-picker-status" },
				"Files attach as absolute paths only — the first agent reads them with its own tools."),
			React.createElement(
				"div",
				{ className: "pipeline-modal-actions" },
				React.createElement("button", { className: "pipeline-btn", onClick: onClose }, "Cancel"),
				React.createElement("button", {
					className: "pipeline-btn pipeline-btn-run",
					disabled: running,
					onClick: () => { onRun(text, files); },
				}, running ? "Running…" : "Run")
			)
		)
	);
}

// The Result modal: the run's terminal outputs plus the continue routes.
// Every route only STAGES text (composer draft) — the user always sends it.
function ResultModal({ result, names, targets, busy, status, onContinueChat, onContinueNewSession, onSendTo, onClose }: {
	result: RunResultLike;
	names: Record<string, string>;
	targets: SessionTarget[];
	busy: string | null;
	status: string | null;
	onContinueChat: () => void;
	onContinueNewSession: () => void;
	onSendTo: (sessionId: string) => void;
	onClose: () => void;
}) {
	const [targetId, setTargetId] = React.useState(targets.length > 0 ? targets[0].id : "");
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	const termName: Record<string, string> = { ...names };
	const rows: React.ReactNode[] = [];
	if (result.ok) {
		Object.keys(result.outputs || {}).forEach((id) => {
			const v = result.outputs![id];
			const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
			rows.push(React.createElement("div", { key: "o-" + id, className: "pipeline-result-row" },
				React.createElement("div", { className: "pipeline-result-label" }, termName[id] || id),
				React.createElement("pre", { className: "pipeline-result-value" }, txt)));
		});
		if (Array.isArray(result.runs)) {
			result.runs.forEach((r) => {
				if (r.status && r.status !== "completed") {
					const warn = "agent " + (termName[r.id] || r.id) + ": " + r.status + (r.error ? " — " + r.error : "");
					rows.push(React.createElement("div", { key: "w-" + r.id, className: "pipeline-result-warn" }, warn));
				}
			});
		}
		if (rows.length === 0) {
			rows.push(React.createElement("div", { key: "empty", className: "pipeline-result-row" }, "No terminal output."));
		}
	} else {
		const msg = result.error || ("graph is invalid: " + (result.validationErrors || []).map((e) => e.message).join("; "));
		rows.push(React.createElement("div", { key: "err", className: "pipeline-result-error" }, msg));
	}
	const canContinue = result.ok === true;
	return React.createElement(
		"div",
		{
			className: "pipeline-modal-overlay",
			onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); },
		},
		React.createElement(
			"div",
			{ className: "pipeline-modal" },
			React.createElement("h3", null, result.ok ? "Pipeline Result" : "Pipeline Failed"),
			React.createElement("div", { className: "pipeline-result" }, rows),
			canContinue ? React.createElement(
				"div",
				{ className: "modal-row" },
				React.createElement("div", { className: "pipeline-modal-actions", style: { marginTop: 0 } },
					React.createElement("button", {
						className: "pipeline-btn",
						disabled: busy !== null,
						title: "Prefill this session's composer with the final output (you send it)",
						onClick: onContinueChat,
					}, busy === "chat" ? "Working…" : "Continue in chat"),
					React.createElement("button", {
						className: "pipeline-btn",
						disabled: busy !== null,
						title: "Create a session in this workspace and prefill its composer (you send it)",
						onClick: onContinueNewSession,
					}, busy === "new" ? "Working…" : "Continue in a new session")
				),
				targets.length > 0 ? React.createElement(
					"div",
					{ className: "pipeline-modal-actions", style: { marginTop: 0 } },
					React.createElement("select", {
						value: targetId,
						onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setTargetId(e.target.value); },
						onKeyDown: stopKey,
						"aria-label": "Target session",
					},
						targets.map((t) => React.createElement("option", { key: t.id, value: t.id }, t.label))
					),
					React.createElement("button", {
						className: "pipeline-btn",
						disabled: busy !== null || targetId.length === 0,
						title: "Open that session and prefill its composer (you send it)",
						onClick: () => { onSendTo(targetId); },
					}, busy === "send" ? "Working…" : "Send to session…")
				) : null,
				React.createElement("div", { className: "pipeline-picker-status" },
					"Every route only prefills a composer — you review and press send.")
			) : null,
			status ? React.createElement("div", { className: "pipeline-modal-status" }, status) : null,
			React.createElement(
				"div",
				{ className: "pipeline-modal-actions" },
				React.createElement("button", { className: "pipeline-btn", onClick: onClose }, "Close")
			)
		)
	);
}

/** Snapshot selector over the workspace list (the standard useWorkspaces hook). */
type UseWorkspaces = <T>(selector: (snapshot: { items?: Array<{ workspaceId?: string; path?: string; sessionIds?: readonly string[] }> }) => T) => T;

function PipelineView({
	sessionId, useSessions, useWorkspaces, inputActions, openView, services, onDismiss,
}: {
	sessionId: string;
	useSessions: UseSessions;
	useWorkspaces?: UseWorkspaces | undefined;
	inputActions?: { setDraft(text: string): void } | undefined;
	openView?: ((view: string, focus: string) => void) | undefined;
	services?: PipelineServices;
	/** Called after a successful continue route when the view is hosted in the
	 * frame-wide panel: the panel closes so the staged composer is visible. */
	onDismiss?: (() => void) | undefined;
}) {
	const NODE_W = 150;
	const NODE_H = 58;
	const [agents, setAgents] = React.useState<CanvasAgent[]>([]);
	const [connections, setConnections] = React.useState<CanvasConnection[]>([]);
	const [seq, setSeq] = React.useState(1);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [connectCursor, setConnectCursor] = React.useState<{ x: number; y: number } | null>(null);
	const [hoverTarget, setHoverTarget] = React.useState<string | null>(null);
	const [showJson, setShowJson] = React.useState(false);
	const [configAgentId, setConfigAgentId] = React.useState<string | null>(null);
	const [showRunModal, setShowRunModal] = React.useState(false);
	const [running, setRunning] = React.useState(false);
	const [runResult, setRunResult] = React.useState<RunResultLike | null>(null);
	const [resultOpen, setResultOpen] = React.useState(false);
	const [continueBusy, setContinueBusy] = React.useState<string | null>(null);
	const [continueStatus, setContinueStatus] = React.useState<string | null>(null);
	const runTextRef = React.useRef("");
	const runFilesRef = React.useRef<string[]>([]);
	const canvasRef = React.useRef<HTMLDivElement | null>(null);
	const idRef = React.useRef(0);
	const dragRef = React.useRef<{ id: string; startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
	const connectRef = React.useRef<{ from: string; cursor: { x: number; y: number }; hoverTarget: string | null } | null>(null);
	// Persistence plumbing.
	const cwdRef = React.useRef<string | undefined>(undefined);
	const loadedRef = React.useRef(false);
	const skipNextPersistRef = React.useRef(false);
	const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const stateRef = React.useRef<{ agents: CanvasAgent[]; connections: CanvasConnection[] }>({ agents: [], connections: [] });

	// The session's workspace root, read off the framework session list
	// (same source the shipped Chat view uses). Undefined until the
	// session summary carries its cwd; until then the view is in-memory.
	const cwd = useSessions((s) => {
		if (!s || !s.byId) return undefined;
		const entry = s.byId[sessionId];
		return entry ? entry.cwd : undefined;
	});
	cwdRef.current = cwd;
	// Workspace sessions offered as "Send to session…" targets (same cwd,
	// excluding this session and subagent rows). Empty constants keep the
	// selector results stable across snapshots.
	const sessionRows = useSessions((s) => (s && s.byId) || EMPTY_ROWS);
	const workspaceItems = useWorkspaces
		? useWorkspaces((s) => (s && s.items) || EMPTY_ITEMS)
		: EMPTY_ITEMS;

	function newId(prefix: string): string {
		idRef.current += 1;
		return prefix + "-" + idRef.current;
	}
	function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
		const rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : { left: 0, top: 0 };
		return { x: clientX - rect.left, y: clientY - rect.top };
	}
	function addAgent(x: number, y: number): CanvasAgent {
		const agent: CanvasAgent = { id: newId("agent"), name: "Agent " + seq, description: "", instructions: "", x, y };
		setAgents((prev) => prev.concat([agent]));
		setSeq((s) => s + 1);
		setSelectedId(agent.id);
		return agent;
	}
	function outPoint(a: CanvasAgent): { x: number; y: number } { return { x: a.x + NODE_W, y: a.y + NODE_H / 2 }; }
	function inPoint(a: CanvasAgent): { x: number; y: number } { return { x: a.x, y: a.y + NODE_H / 2 }; }

	// node drag (pointer capture on the node)
	function onNodePointerDown(e: React.PointerEvent, agent: CanvasAgent) {
		e.preventDefault(); e.stopPropagation();
		if (canvasRef.current) canvasRef.current.focus();
		e.currentTarget.setPointerCapture(e.pointerId);
		setSelectedId(agent.id);
		dragRef.current = { id: agent.id, startClientX: e.clientX, startClientY: e.clientY, startX: agent.x, startY: agent.y };
	}
	function onNodePointerMove(e: React.PointerEvent) {
		const d = dragRef.current;
		if (!d) return;
		const nx = d.startX + (e.clientX - d.startClientX);
		const ny = d.startY + (e.clientY - d.startClientY);
		setAgents((prev) => prev.map((a) => (a.id === d.id ? { ...a, x: nx, y: ny } : a)));
	}
	function onNodePointerUp() {
		dragRef.current = null;
	}

	// connect output -> input
	function onOutputPointerDown(e: React.PointerEvent, agent: CanvasAgent) {
		e.preventDefault(); e.stopPropagation();
		if (canvasRef.current) canvasRef.current.focus();
		const p = canvasPoint(e.clientX, e.clientY);
		connectRef.current = { from: agent.id, cursor: { x: p.x, y: p.y }, hoverTarget: null };
		setConnectCursor({ x: p.x, y: p.y });
		setSelectedId(agent.id);
	}
	function onInputPointerEnter(e: React.PointerEvent, agent: CanvasAgent) {
		e.stopPropagation();
		if (!connectRef.current) return;
		connectRef.current.hoverTarget = agent.id;
		setHoverTarget(agent.id);
	}
	function onInputPointerLeave(e: React.PointerEvent, agent: CanvasAgent) {
		if (connectRef.current && connectRef.current.hoverTarget === agent.id) {
			connectRef.current.hoverTarget = null;
			setHoverTarget(null);
		}
	}
	function onContainerPointerMove(e: React.PointerEvent) {
		const c = connectRef.current;
		if (!c) return;
		const p = canvasPoint(e.clientX, e.clientY);
		c.cursor = p;
		setConnectCursor({ x: p.x, y: p.y });
	}
	function onContainerPointerUp() {
		const c = connectRef.current;
		if (!c) return;
		const target = c.hoverTarget;
		if (target != null && target !== c.from) {
			const exists = connections.some((conn) => conn.source === c.from && conn.target === target);
			if (!exists) {
				setConnections((prev) => prev.concat([{ id: newId("conn"), source: c.from, target }]));
			}
		}
		connectRef.current = null;
		setHoverTarget(null);
		setConnectCursor(null);
	}
	function onContainerPointerLeave() {
		if (connectRef.current) {
			connectRef.current = null;
			setHoverTarget(null);
			setConnectCursor(null);
		}
	}
	function onCanvasPointerDown(e: React.PointerEvent) {
		if (canvasRef.current) canvasRef.current.focus();
		setSelectedId(null);
		if (connectRef.current) {
			connectRef.current = null;
			setHoverTarget(null);
			setConnectCursor(null);
		}
	}

	function addAgentFromToolbar() {
		const n = agents.length;
		addAgent(60 + (n % 4) * 40, 40 + (n % 6) * 34);
	}
	function deleteSelected() {
		if (!selectedId) return;
		setAgents((prev) => prev.filter((a) => a.id !== selectedId));
		setConnections((prev) => prev.filter((c) => c.source !== selectedId && c.target !== selectedId));
		setSelectedId(null);
	}
	function clearAll() {
		setAgents([]); setConnections([]); setSelectedId(null); setHoverTarget(null); setConnectCursor(null);
		dragRef.current = null; connectRef.current = null;
		setSeq(1); idRef.current = 0;
		setRunResult(null); setResultOpen(false); setShowRunModal(false);
		runTextRef.current = ""; runFilesRef.current = [];
	}

	// Run the pipeline: POST the snapshot the user currently sees (the graph
	// as-is, plus the composed pipeline input from the Run modal and the
	// session id) to the Host's /run route, which executes it sequentially
	// and returns the contract's `{ outputs: { [terminalId]: output } }` shape.
	function run(text: string, files: string[]) {
		if (running) return;
		runTextRef.current = text;
		runFilesRef.current = files;
		const g = buildGraph(agents, connections);
		setRunning(true);
		setRunResult(null);
		setShowRunModal(false);
		fetch(ENDPOINT + "/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, graph: g, input: composePipelineInput(text, files) }),
		})
			.then((r) => {
				return r.text().then((body) => {
					let data: RunResultLike | null = null;
					try { data = body.length > 0 ? JSON.parse(body) : null; } catch (e) { data = null; }
					if (!r.ok) return { ok: false, error: (data && data.error) ? data.error : ("HTTP " + r.status) };
					return data || { ok: false, error: "empty response" };
				});
			})
			.then((data) => { setRunning(false); setRunResult(data); setResultOpen(true); })
			.catch((err: unknown) => { setRunning(false); setRunResult({ ok: false, error: String(err) }); setResultOpen(true); });
	}

	// Completion query against the harness `@`-mention file-reference source
	// (workspace files and directories, path-only — the same candidates the
	// composer's @ menu offers).
	function queryFiles(query: string, signal: AbortSignal): Promise<FileRefCandidate[]> {
		const remote = services && services.remote;
		if (!remote || !remote.fileReferences || typeof remote.fileReferences.list !== "function") {
			return Promise.reject(new Error("file references unavailable"));
		}
		return remote.fileReferences.list(sessionId, query, signal).then((r) =>
			(r && r.ok === true && Array.isArray(r.value)) ? r.value : []);
	}

	function nameOf(id: string): string {
		for (const a of agents) if (a.id === id) return a.name;
		return id;
	}
	const continueText = runResult && runResult.ok ? finalOutputText(runResult.outputs || {}, nameOf) : "";

	// Stage text into a session's composer WITHOUT sending. The current
	// session goes through the standard inputActions; other sessions through
	// the conversation service's per-session input shell.
	function stageDraft(targetSessionId: string, text: string): boolean {
		if (text.length === 0) return false;
		if (targetSessionId === sessionId && inputActions && typeof inputActions.setDraft === "function") {
			inputActions.setDraft(text);
			return true;
		}
		const conversation = services && services.conversation;
		if (conversation && conversation.input && typeof conversation.input.shell === "function") {
			try {
				conversation.input.shell(targetSessionId).setDraft(text);
				return true;
			} catch {
				// No live binding for that session — reported by the caller.
			}
		}
		return false;
	}
	function continueInChat() {
		if (!stageDraft(sessionId, continueText)) {
			setContinueStatus("Composer access is unavailable in this view.");
			return;
		}
		if (typeof openView === "function") openView("chat", "");
		else if (onDismiss) onDismiss();
		setResultOpen(false);
	}
	async function continueInNewSession() {
		setContinueBusy("new");
		setContinueStatus(null);
		try {
			const sessions = services && services.sessions;
			const uiWorkspace = services && services.uiWorkspace;
			let newId: string | undefined;
			if (uiWorkspace && typeof uiWorkspace.connectWorkspace === "function") {
				// The workspace holding this session (fall back to the cwd match).
				const ws = workspaceItems.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1)
					|| (cwd ? workspaceItems.find((w) => w.path === cwd) : undefined);
				if (ws && typeof ws.workspaceId === "string") newId = await uiWorkspace.connectWorkspace(ws.workspaceId);
			}
			if (newId === undefined && sessions && typeof sessions.create === "function" && cwd) {
				newId = await sessions.create({ cwd });
			}
			if (typeof newId !== "string" || newId.length === 0) throw new Error("no session could be created for this workspace");
			if (sessions && typeof sessions.open === "function") sessions.open(newId);
			if (!stageDraft(newId, continueText)) throw new Error("composer access unavailable");
			setResultOpen(false);
			if (onDismiss) onDismiss();
		} catch (err) {
			setContinueStatus("Could not start a new session: " + String(err));
		} finally {
			setContinueBusy(null);
		}
	}
	async function sendToSession(targetId: string) {
		setContinueBusy("send");
		setContinueStatus(null);
		try {
			const sessions = services && services.sessions;
			if (sessions && typeof sessions.open === "function") sessions.open(targetId);
			if (!stageDraft(targetId, continueText)) throw new Error("composer access unavailable");
			setResultOpen(false);
			if (onDismiss) onDismiss();
		} catch (err) {
			setContinueStatus("Could not stage the output: " + String(err));
		} finally {
			setContinueBusy(null);
		}
	}
	// Workspace sessions offered as "Send to session…" targets: same cwd,
	// excluding this session, subagent children (parentId), blank leftovers,
	// and subagent-origin rows. The id suffix disambiguates same-titled rows.
	const targets: SessionTarget[] = Object.values(sessionRows)
		.filter((r) => r && typeof r.id === "string" && r.id !== sessionId
			&& r.cwd === cwd && !r.parentId && !r.blank && r.origin !== "subagent")
		.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
		.map((r) => {
			const label = r.displayTitle || r.title || (r.id as string);
			return { id: r.id as string, label: label + " · " + (r.id as string).slice(-6) };
		});
	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
		if (e.key === "Escape") { if (connectRef.current) { connectRef.current = null; setHoverTarget(null); setConnectCursor(null); } }
	}
	function handleDragOver(e: React.DragEvent) { e.preventDefault(); }
	function handleCanvasDrop(e: React.DragEvent) {
		e.preventDefault();
		if (e.dataTransfer.getData("application/x-pipeline-agent") === "agent") {
			const p = canvasPoint(e.clientX, e.clientY);
			addAgent(p.x - NODE_W / 2, p.y - NODE_H / 2);
		}
	}

	// Load the saved graph once the workspace root is known.
	React.useEffect(() => {
		if (typeof cwd !== "string" || cwd.length === 0) return;
		let cancelled = false;
		fetch(ENDPOINT + "?cwd=" + encodeURIComponent(cwd), { cache: "no-store" })
			.then((r) => r.json())
			.then((data) => {
				if (cancelled) return;
				const p = data && data.ok === true ? data.pipeline : null;
				const as = p && Array.isArray(p.agents) ? p.agents : [];
				const cs = p && Array.isArray(p.connections) ? p.connections : [];
				skipNextPersistRef.current = true;
				loadedRef.current = true;
				setAgents(as.map((a: { id: unknown; name: unknown; description?: unknown; instructions?: unknown; x?: unknown; y?: unknown }) => ({
					id: String(a.id), name: String(a.name), description: String(a.description || ""),
					instructions: String(a.instructions || ""), x: Number(a.x) || 0, y: Number(a.y) || 0,
				})));
				setConnections(cs.map((c: { id: unknown; source: unknown; target: unknown }) => ({
					id: String(c.id), source: String(c.source), target: String(c.target),
				})));
				let maxId = 0;
				as.forEach((a: { id: unknown }) => { const n = numericSuffix(a.id); if (n > maxId) maxId = n; });
				cs.forEach((c: { id: unknown }) => { const n = numericSuffix(c.id); if (n > maxId) maxId = n; });
				idRef.current = maxId;
				let maxSeq = 0;
				as.forEach((a: { name: unknown }) => {
					const m = /^Agent\s+(\d+)$/.exec(String(a.name));
					const v = m ? parseInt(m[1], 10) : 0;
					if (v > maxSeq) maxSeq = v;
				});
				setSeq(maxSeq + 1);
			})
			.catch(() => { loadedRef.current = true; });
		return () => { cancelled = true; };
	}, [cwd]);

	// Persist on every graph change (debounced so an in-progress drag
	// coalesces into one write). A freshly-loaded graph is not written back
	// immediately (skipNextPersist consumed once).
	React.useEffect(() => {
		stateRef.current = { agents, connections };
		if (!loadedRef.current) return;
		if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return; }
		if (!(typeof cwdRef.current === "string" && cwdRef.current.length > 0)) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			const g = buildGraph(stateRef.current.agents, stateRef.current.connections);
			fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: cwdRef.current, graph: g }),
			}).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [agents, connections]);

	const gesture = connectRef.current;
	const edges: React.ReactNode[] = [];
	connections.forEach((c) => {
		let src: CanvasAgent | null = null, tgt: CanvasAgent | null = null;
		for (let i = 0; i < agents.length; i++) {
			if (agents[i].id === c.source) src = agents[i];
			if (agents[i].id === c.target) tgt = agents[i];
		}
		if (!src || !tgt) return;
		const s = outPoint(src), t = inPoint(tgt);
		const d = "M" + s.x + " " + s.y + " C" + (s.x + 60) + " " + s.y + " " + (t.x - 60) + " " + t.y + " " + t.x + " " + t.y;
		edges.push(React.createElement("path", { key: c.id, d, className: "pipeline-edge", markerEnd: "url(#pipeline-arrow)" }));
	});
	let tempEdge: React.ReactNode = null;
	if (gesture) {
		let src0: CanvasAgent | null = null;
		for (let j = 0; j < agents.length; j++) if (agents[j].id === gesture.from) src0 = agents[j];
		if (src0) {
			const s0 = outPoint(src0);
			const cx = gesture.cursor ? gesture.cursor.x : s0.x;
			const cy = gesture.cursor ? gesture.cursor.y : s0.y;
			const d0 = "M" + s0.x + " " + s0.y + " C" + (s0.x + 60) + " " + s0.y + " " + (cx - 60) + " " + cy + " " + cx + " " + cy;
			tempEdge = React.createElement("path", { d: d0, className: "pipeline-edge-temp" });
		}
	}

	const nodes = agents.map((agent) => {
		const selected = agent.id === selectedId;
		const hoveredIn = hoverTarget === agent.id && gesture;
		return React.createElement(
			"div",
			{
				key: agent.id,
				className: "pipeline-node" + (selected ? " selected" : ""),
				style: { left: agent.x + "px", top: agent.y + "px" },
				"data-agent-id": agent.id,
				onPointerDown: (e: React.PointerEvent) => { onNodePointerDown(e, agent); },
				onPointerMove: onNodePointerMove,
				onPointerUp: onNodePointerUp,
				onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); setConfigAgentId(agent.id); },
			},
			React.createElement("div", { className: "node-name" }, agent.name),
			React.createElement("div", { className: "node-sub" }, agent.id),
			React.createElement("div", {
				className: "pipeline-port in" + (hoveredIn ? " hover" : ""),
				onPointerEnter: (e: React.PointerEvent) => { onInputPointerEnter(e, agent); },
				onPointerLeave: (e: React.PointerEvent) => { onInputPointerLeave(e, agent); },
				onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); },
				onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); },
				title: "Input",
			}),
			React.createElement("div", {
				className: "pipeline-port out",
				onPointerDown: (e: React.PointerEvent) => { onOutputPointerDown(e, agent); },
				onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); },
				title: "Output",
			})
		);
	});

	const graphData = buildGraph(agents, connections);
	const validation: ValidationResult = validateGraph(graphData);
	const jsonText = JSON.stringify(graphData, null, 2);

	let configAgent: CanvasAgent | null = null;
	for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];

	return React.createElement(
		"div",
		{
			className: "pipeline-view",
			onPointerMove: onContainerPointerMove,
			onPointerUp: onContainerPointerUp,
			onPointerLeave: onContainerPointerLeave,
		},
		React.createElement(
			"div",
			{ className: "pipeline-toolbar" },
			React.createElement("h3", null, "Agent Pipeline"),
			React.createElement("div", { className: "spacer" }),
			React.createElement("span", { className: "stat" }, agents.length + " agents · " + connections.length + " connections"),
			React.createElement(
				"span",
				{
					className: "pipeline-validation" + (validation.ok ? " ok" : " err"),
					title: validation.ok ? "Graph is a valid DAG" : "Graph has validation issues (see the issue list below)",
					role: "status",
				},
				validation.ok ? "Valid" : validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")
			),
			React.createElement("button", { className: "pipeline-btn", onClick: addAgentFromToolbar }, "+ Add Agent"),
			React.createElement("button", { className: "pipeline-btn", onClick: deleteSelected, disabled: !selectedId }, "Delete"),
			React.createElement("button", { className: "pipeline-btn", onClick: () => { setShowJson(!showJson); } }, showJson ? "Hide JSON" : "View JSON"),
			React.createElement("button", { className: "pipeline-btn", onClick: clearAll }, "Clear"),
			runResult && !resultOpen ? React.createElement("button", {
				className: "pipeline-btn",
				title: "Reopen the last run's result",
				onClick: () => { setResultOpen(true); },
			}, "Result") : null,
			React.createElement("button", {
				className: "pipeline-btn pipeline-btn-run",
				disabled: running || !validation.ok,
				title: running ? "Running…" : "Open the run dialog",
				onClick: () => { setShowRunModal(true); },
			}, running ? "Running…" : "Run")
		),
		validation.ok ? null : React.createElement(
			"div",
			{ className: "pipeline-issues" },
			validation.errors.map((err) => {
				return React.createElement("div", { key: err.code + ":" + err.message, className: "pipeline-issue" }, err.message);
			})
		),
		React.createElement(
			"div",
			{ className: "pipeline-body" },
			React.createElement(
				"div",
				{ className: "pipeline-palette" },
				React.createElement("div", { className: "palette-title" }, "Palette"),
				React.createElement(
					"div",
					{
						className: "palette-item",
						draggable: true,
						onDragStart: (e: React.DragEvent) => {
							e.dataTransfer.setData("application/x-pipeline-agent", "agent");
							e.dataTransfer.effectAllowed = "copy";
						},
					},
					React.createElement("div", { className: "palette-icon" }),
					"Agent"
				)
			),
			React.createElement(
				"div",
				{
					className: "pipeline-canvas",
					ref: canvasRef,
					tabIndex: 0,
					onDragOver: handleDragOver,
					onDrop: handleCanvasDrop,
					onPointerDown: onCanvasPointerDown,
					onKeyDown: onKeyDown,
				},
				React.createElement(
					"svg",
					{ className: "pipeline-edges" },
					React.createElement(
						"defs",
						null,
						React.createElement(
							"marker",
							{ id: "pipeline-arrow", markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: "auto", markerUnits: "strokeWidth" },
							React.createElement("path", { d: "M0,0 L6,3 L0,6 Z", className: "pipeline-arrowfill" })
						)
					),
					edges,
					tempEdge
				),
				nodes,
				agents.length === 0 ? React.createElement("div", { className: "pipeline-hint" }, "Drag an Agent from the palette onto the canvas") : null
			)
		),
		showJson ? React.createElement("div", { className: "pipeline-json" }, React.createElement("pre", null, jsonText)) : null,
		configAgent ? React.createElement(AgentConfigPanel, {
			key: configAgent.id,
			agent: configAgent,
			onSave: (updated) => {
				setAgents((prev) => prev.map((a) =>
					a.id === updated.id
						? { ...a, name: updated.name, description: updated.description, instructions: updated.instructions }
						: a
				));
				setConfigAgentId(null);
			},
			onClose: () => { setConfigAgentId(null); },
		}) : null,
		showRunModal ? React.createElement(RunModal, {
			cwd,
			initialText: runTextRef.current,
			initialFiles: runFilesRef.current,
			running,
			fileList: services && services.remote && services.remote.fileReferences ? queryFiles : null,
			onRun: run,
			onClose: () => { setShowRunModal(false); },
		}) : null,
		runResult && resultOpen ? React.createElement(ResultModal, {
			result: runResult,
			names: agents.reduce<Record<string, string>>((acc, a) => { acc[a.id] = a.name; return acc; }, {}),
			targets,
			busy: continueBusy,
			status: continueStatus,
			onContinueChat: continueInChat,
			onContinueNewSession: continueInNewSession,
			onSendTo: sendToSession,
			onClose: () => { setResultOpen(false); setContinueStatus(null); },
		}) : null
	);
}

// ---- Always-available entry: sidebar footer trigger + frame-wide panel ----
//
// The harness hides the whole conversation session body (header tabs and view
// area included) while a session is blank — a brand-new session therefore
// shows NO Pipelines tab, and a plugin cannot change that gate. The additive
// root-scope seats are the supported route around it: a "Pipelines" trigger in
// `sidebar.footer.action` (the documented place to add to the sidebar) opens a
// panel in `shell.overlay` (the documented additive frame-wide surface), which
// renders in EVERY app state. The panel binds to the CURRENT session read off
// the root `useSessions` standard hook (the graph itself is stored per
// workspace cwd), so composing and running work from a brand-new session too.

/** Shared open state between the sidebar trigger and the shell-overlay panel. */
function createPanelGate() {
	let open = false;
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		get(): boolean { return open; },
		set(next: boolean): void {
			if (open === next) return;
			open = next;
			listeners.forEach((fn) => fn());
		},
	};
}
const panelGate = createPanelGate();

/** A small two-node flow glyph for the trigger (no icon package in the bundle). */
function PipelineGlyph({ size }: { size: number }) {
	return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true" },
		React.createElement("circle", { cx: 3.5, cy: 8, r: 2.1, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }),
		React.createElement("path", { d: "M5.6 8h4.8", stroke: "currentColor", strokeWidth: 1.5 }),
		React.createElement("circle", { cx: 12.5, cy: 8, r: 2.1, fill: "none", stroke: "currentColor", strokeWidth: 1.5 })
	);
}

/** The sidebar footer action: labeled row when the column is wide, icon on the rail. */
function PipelineTriggerRow({ wide }: { wide?: boolean }) {
	const open = React.useSyncExternalStore(panelGate.subscribe, panelGate.get);
	return React.createElement("div", { className: "pipeline-trigger" + (wide ? "" : " rail") },
		React.createElement("button", {
			type: "button",
			className: "pipeline-trigger-btn",
			"aria-label": "Pipelines",
			title: "Pipelines",
			"aria-expanded": open,
			onClick: () => { panelGate.set(true); },
		},
			React.createElement(PipelineGlyph, { size: wide ? 16 : 18 }),
			wide ? React.createElement("span", { className: "pipeline-trigger-label" }, "Pipelines") : null
		)
	);
}

/**
 * The shell-overlay entry: a one-hook gate so the hook count never changes
 * between closed and open renders; the panel body mounts fresh when opened.
 */
function PipelinePanelEntry({ useSessions, services }: { useSessions?: UseSessions | undefined; services?: PipelineServices | undefined }) {
	const open = React.useSyncExternalStore(panelGate.subscribe, panelGate.get);
	if (!open) return null;
	return React.createElement(PipelinePanel, { useSessions, services });
}

/** The frame-wide panel hosting the canvas for the CURRENT session. */
function PipelinePanel({ useSessions, services }: { useSessions?: UseSessions | undefined; services?: PipelineServices | undefined }) {
	const hasSessions = typeof useSessions === "function";
	const current = hasSessions
		? (useSessions as UseSessions)((s) => (s && s.current) as string | undefined)
		: undefined;
	const cwd = hasSessions
		? (useSessions as UseSessions)((s) => {
			const id = s && s.current;
			if (!id || !s.byId) return undefined;
			const row = s.byId[id];
			return row ? row.cwd : undefined;
		})
		: undefined;
	const close = () => { panelGate.set(false); };
	return React.createElement("div", { className: "pipeline-shell-backdrop" },
		React.createElement(
			"div",
			{ className: "pipeline-shell", "data-pipeline-shell": "true" },
			React.createElement("div", { className: "pipeline-shell-head" },
				React.createElement("h4", null, "Pipelines"),
				cwd ? React.createElement("span", { className: "pipeline-shell-cwd", title: cwd }, cwd) : null,
				React.createElement("div", { className: "spacer" }),
				React.createElement("button", {
					className: "pipeline-btn",
					title: "Close the pipelines panel",
					onClick: close,
				}, "Close")
			),
			hasSessions && typeof current === "string" && current.length > 0
				? PipelineView({
					sessionId: current,
					useSessions: useSessions as UseSessions,
					services,
					onDismiss: close,
				})
				: React.createElement("div", { className: "pipeline-shell-empty" },
					hasSessions
						? "Open a session to compose and run pipelines — the graph is stored per workspace."
						: "The session feed is unavailable here; open the Pipelines tab inside a session instead.")
		)
	);
}

// Declared services are BOTH the activation gate (the runner parks the
// package until each provider exists) and the guard allowlist — the dynamic
// ctx proxy rejects property reads of undeclared services, and nested Remote
// namespaces need their own dotted entry (same convention ui-reference uses).
export const inject = ["slots", "sessions", "uiWorkspace", "conversation", "remote", "remote.fileReferences"];

interface PipelineCtx extends SlotsCtx {
	sessions?: SessionsService;
	uiWorkspace?: UiWorkspaceService;
	conversation?: ConversationService;
	remote?: RemoteService;
}

export function apply(ctx: PipelineCtx): void {
	// Capture the services for the view once; the guard proxy resolves each
	// property read at this point, so keep the captured object stable.
	const services: PipelineServices = {
		sessions: ctx.sessions,
		uiWorkspace: ctx.uiWorkspace,
		conversation: ctx.conversation,
		remote: ctx.remote,
	};
	ctx.slots.inject("conversation.view", () =>
		ctx.slots.register(
			{ name: "conversation.view", id: "pipeline", order: 30, label: "Pipelines" },
			(props: Record<string, unknown>) =>
				PipelineView({
					sessionId: props.sessionId as string,
					useSessions: props.useSessions as UseSessions,
					useWorkspaces: props.useWorkspaces as UseWorkspaces | undefined,
					inputActions: props.inputActions as { setDraft(text: string): void },
					openView: props.openView as (view: string, focus: string) => void,
					services,
				})
		)
	);
	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{ name: "sidebar.footer.action", id: "pipeline-trigger", order: 20 },
			(props: Record<string, unknown>) =>
				PipelineTriggerRow({ wide: props.wide as boolean | undefined })
		)
	);
	ctx.slots.inject("shell.overlay", () =>
		ctx.slots.register(
			{ name: "shell.overlay", id: "pipeline-panel", order: 20 },
			(props: Record<string, unknown>) =>
				PipelinePanelEntry({
					useSessions: props.useSessions as UseSessions | undefined,
					services,
				})
		)
	);
}
