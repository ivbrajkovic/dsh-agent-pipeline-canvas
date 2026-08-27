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
// The view renders the whole node workspace: a palette with a draggable Agent,
// a canvas, node move/select, and output→input connections with directed edges.
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
		".pipeline-config{width:380px;max-width:92%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)}",
		".pipeline-config h3{margin:0;font-size:14px;font-weight:600}",
		".pipeline-config .config-row{display:flex;flex-direction:column;gap:4px}",
		".pipeline-config label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-config input,.pipeline-config textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
		".pipeline-config input:focus,.pipeline-config textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-config textarea{min-height:72px;resize:vertical}",
		".pipeline-config .config-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
		".pipeline-run-input{min-width:140px;flex:0 1 auto;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;box-sizing:border-box}",
		".pipeline-run-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
		".pipeline-btn-run{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
		".pipeline-btn-run:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
		".pipeline-result{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,var(--dsw-alias-bg-base));border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 10px;max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
		".pipeline-result-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
		".pipeline-result-row{display:flex;flex-direction:column;gap:2px}",
		".pipeline-result-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
		".pipeline-result-value{margin:0;padding:6px 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
		".pipeline-result-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
		".pipeline-result-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
	].join("");
	document.head.appendChild(tag);
}

const ENDPOINT = "/dsh-agent-pipeline";
const SAVE_DEBOUNCE_MS = 250;

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
	runs?: Array<{ id: string; status?: string; error?: string }>;
	error?: string;
	validationErrors?: Array<{ message?: string }>;
}

interface SessionSummary {
	byId?: Record<string, { cwd?: string }>;
}

type UseSessions = <T>(selector: (session: SessionSummary | undefined) => T) => T;

interface SlotsCtx {
	slots: {
		inject(slot: string, register: () => unknown): unknown;
		register(
			opts: { name: string; id: string; order: number; label: string },
			component: unknown,
		): unknown;
	};
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

function PipelineView({ sessionId, useSessions }: { sessionId: string; useSessions: UseSessions }) {
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
	const [runInput, setRunInput] = React.useState("");
	const [running, setRunning] = React.useState(false);
	const [runResult, setRunResult] = React.useState<RunResultLike | null>(null);
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
		setRunResult(null);
	}

	// Run the pipeline: POST the snapshot the user currently sees (the graph
	// as-is, plus the pipeline input and the session id) to the Host's /run
	// route, which executes it sequentially and returns the contract's
	// `{ outputs: { [terminalId]: output } }` shape.
	function run() {
		if (running) return;
		const g = buildGraph(agents, connections);
		setRunning(true);
		setRunResult(null);
		fetch(ENDPOINT + "/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, graph: g, input: runInput }),
		})
			.then((r) => {
				return r.text().then((text) => {
					let data: RunResultLike | null = null;
					try { data = text.length > 0 ? JSON.parse(text) : null; } catch (e) { data = null; }
					if (!r.ok) return { ok: false, error: (data && data.error) ? data.error : ("HTTP " + r.status) };
					return data || { ok: false, error: "empty response" };
				});
			})
			.then((data) => { setRunning(false); setRunResult(data); })
			.catch((err: unknown) => { setRunning(false); setRunResult({ ok: false, error: String(err) }); });
	}
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

	let resultRows: React.ReactNode[] | null = null;
	if (runResult) {
		const termName: Record<string, string> = {};
		agents.forEach((a) => { termName[a.id] = a.name; });
		resultRows = [];
		if (runResult.ok) {
			Object.keys(runResult.outputs || {}).forEach((id) => {
				const v = runResult.outputs![id];
				const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
				resultRows!.push(React.createElement("div", { key: "o-" + id, className: "pipeline-result-row" },
					React.createElement("div", { className: "pipeline-result-label" }, termName[id] || id),
					React.createElement("pre", { className: "pipeline-result-value" }, txt)));
			});
			if (Array.isArray(runResult.runs)) {
				runResult.runs.forEach((r) => {
					if (r.status && r.status !== "completed") {
						const warn = "agent " + (termName[r.id] || r.id) + ": " + r.status + (r.error ? " — " + r.error : "");
						resultRows!.push(React.createElement("div", { key: "w-" + r.id, className: "pipeline-result-warn" }, warn));
					}
				});
			}
			if (resultRows.length === 0) {
				resultRows.push(React.createElement("div", { key: "empty", className: "pipeline-result-row" }, "No terminal output."));
			}
		} else {
			const msg = runResult.error || ("graph is invalid: " + (runResult.validationErrors || []).map((e) => e.message).join("; "));
			resultRows.push(React.createElement("div", { key: "err", className: "pipeline-result-error" }, msg));
		}
	}

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
			React.createElement("input", {
				className: "pipeline-run-input",
				type: "text",
				placeholder: "Pipeline input",
				value: runInput,
				onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setRunInput(e.target.value); },
			}),
			React.createElement("button", {
				className: "pipeline-btn pipeline-btn-run",
				disabled: running || !validation.ok,
				title: running ? "Running…" : "Run the pipeline",
				onClick: run,
			}, running ? "Running…" : "Run")
		),
		validation.ok ? null : React.createElement(
			"div",
			{ className: "pipeline-issues" },
			validation.errors.map((err) => {
				return React.createElement("div", { key: err.code + ":" + err.message, className: "pipeline-issue" }, err.message);
			})
		),
		runResult ? React.createElement(
			"div",
			{ className: "pipeline-result" },
			React.createElement("div", { className: "pipeline-result-title" }, runResult.ok ? "Pipeline result" : "Pipeline failed"),
			resultRows
		) : null,
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
		}) : null
	);
}

export const inject = ["slots"];

export function apply(ctx: SlotsCtx): void {
	ctx.slots.inject("conversation.view", () =>
		ctx.slots.register(
			{ name: "conversation.view", id: "pipeline", order: 30, label: "Pipelines" },
			PipelineView
		)
	);
}
