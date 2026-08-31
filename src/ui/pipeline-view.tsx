// The Pipelines canvas view: the whole node workspace — a palette with a
// draggable Agent, a canvas, node move/select, the node edit button, the
// breakpoint toggle, output→input connections with directed edges, the toolbar
// (add/delete/JSON/clear/run/abort), load/save through the Host routes, the
// run/result modals, and the paused-run inspection modal. Renders inside the
// per-session view tab AND the frame-wide shell panel (see ./shell-panel.tsx);
// the two hosts differ only in the props below.
//
// Persistence is PER SESSION: the load GET and the debounced save POST carry
// the session id, so each session owns
// `.agent-pipeline/pipelines/<sessionId>.json` — the first edit forks that
// file from the legacy workspace `pipeline.json`, which keeps serving as the
// read-through fallback until then. The effect refires on a session switch
// (the shell panel stays mounted) and resets the previous session's run view
// state before the new graph lands.
//
// Running is DURABLE: the Run dialog POSTs the snapshot to the Host's /run
// route, which starts a run executor in the Host process and returns a runId
// immediately (one active run per session — a 409 reports the other run).
// The view then follows the run's record over SSE (snapshot on connect/reconnect,
// update per transition); EventSource's auto-reconnect self-heals a profile
// restart. When the record pauses at a breakpointed agent, the inspection modal
// opens with the composed input, the adopted output, and the control actions
// (Resume / Rerun / Steer / Abort). On a terminal state (completed / aborted /
// error) the result modal opens. A page reload re-discovers the active run via
// the pipeline GET's `run` field and re-subscribes — runs outlive the tab.
// When nothing is active, the same GET's `lastRun` (the newest record of any
// state) restores the last run's outcome after a remount: the Result button
// returns and the nodes keep their final statuses; the modal itself stays
// closed (the user closed it before leaving).
import * as React from "react";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import { validateGraph } from "../graph.ts";
import { classifyGraph, topoOrder } from "../execution.ts";
import { projectNodes, type ProjectedNode } from "../projection.ts";
import { composePipelineInput, finalOutputText } from "../message.ts";
import type { PortSide, ValidationResult } from "../types.ts";
import { AgentConfigPanel } from "./agent-config.tsx";
import { RunModal } from "./run-modal.tsx";
import { ResultModal } from "./result-modal.tsx";
import { InspectModal } from "./inspect-modal.tsx";
import { NodeMenu, type NodeMenuTarget } from "./node-menu.tsx";
import {
	ENDPOINT,
	EMPTY_ITEMS,
	EMPTY_ROWS,
	SAVE_DEBOUNCE_MS,
	buildGraph,
	loadAgent,
	numericSuffix,
	type CanvasAgent,
	type CanvasConnection,
	type FileRefCandidate,
	type PipelineServices,
	type RunRecordLike,
	type RunResultLike,
	type SessionTarget,
	type UseSessions,
	type UseWorkspaces,
} from "./shared.ts";
import "./canvas.css";

// One-shot "show this session's Chat" navigation request, set by the
// transcript/continue routes right before they open another session. The
// conversation view-tab selection is a PER-SESSION store, and the only write
// handle bound to a given session's store is the openView prop its OWN view
// receives — a click site's openView writes the PREVIOUS session's store and
// cannot reach the target. So the request is stashed here and consumed by the
// PipelineView instance that mounts under the target session (which is exactly
// the case where the target's remembered tab is this canvas instead of Chat).
let pendingChatView: string | null = null;

/** Stash a request and let it self-expire when no pipeline view mounts for it
 * (the target already shows Chat — nothing to switch). The window only has to
 * cover the open + history replay of the target session. */
function requestChatView(sessionId: string) {
	pendingChatView = sessionId;
	window.setTimeout(() => { if (pendingChatView === sessionId) pendingChatView = null; }, 5000);
}

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
	// The durable run being followed (running or paused); null when idle/terminal.
	const [activeRun, setActiveRun] = React.useState<RunRecordLike | null>(null);
	const [startPending, setStartPending] = React.useState(false);
	const [runResult, setRunResult] = React.useState<RunResultLike | null>(null);
	const [resultOpen, setResultOpen] = React.useState(false);
	// The most recent TERMINAL record, kept so the canvas keeps showing the
	// per-node statuses after the run ends (and after a remount restores it);
	// an active run's live projection takes precedence while one exists.
	const [doneRun, setDoneRun] = React.useState<RunRecordLike | null>(null);
	const [continueBusy, setContinueBusy] = React.useState<string | null>(null);
	const [continueStatus, setContinueStatus] = React.useState<string | null>(null);
	// The paused-run inspection modal: closed per (run, agent) by the user.
	const [inspectDismissedFor, setInspectDismissedFor] = React.useState<string | null>(null);
	const [controlBusy, setControlBusy] = React.useState<string | null>(null);
	const [controlStatus, setControlStatus] = React.useState<string | null>(null);
	// A connection drafted between two multi-port endpoints: the edge needs
	// its port names before it is added (the picker overlay completes it).
	const [edgeDraft, setEdgeDraft] = React.useState<{ id: string; source: string; target: string; sourcePort: string; targetPort: string } | null>(null);
	// The node context menu: which agent it opened on and the viewport point
	// (clientX/clientY) it opened at; null when closed.
	const [nodeMenu, setNodeMenu] = React.useState<NodeMenuTarget | null>(null);
	const runTextRef = React.useRef("");
	const runFilesRef = React.useRef<string[]>([]);
	/** The live SSE subscription for the active run's record. */
	const sseRef = React.useRef<EventSource | null>(null);
	const canvasRef = React.useRef<HTMLDivElement | null>(null);
	const idRef = React.useRef(0);
	const dragRef = React.useRef<{ id: string; startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
	const connectRef = React.useRef<{ from: string; cursor: { x: number; y: number }; hoverTarget: string | null; startPort?: string } | null>(null);
	// Persistence plumbing.
	const cwdRef = React.useRef<string | undefined>(undefined);
	// The session key rides beside cwdRef for the same reason: the save
	// effect's deps are the graph only, so both request scopes are read at
	// save time, not from a possibly stale closure.
	const sessionIdRef = React.useRef("");
	const loadedRef = React.useRef(false);
	const skipNextPersistRef = React.useRef(false);
	const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const stateRef = React.useRef<{ agents: CanvasAgent[]; connections: CanvasConnection[] }>({ agents: [], connections: [] });

	// Consume a pending chat-navigation request (see pendingChatView): when this
	// canvas is the view the TARGET session remembered, hand the tab to Chat —
	// the transcript/continue route's whole point. Only when this host supplied
	// openView (the per-session tab store write path).
	React.useEffect(() => {
		if (pendingChatView !== null && pendingChatView === sessionId && typeof openView === "function") {
			pendingChatView = null;
			openView("chat", "");
		}
	}, [sessionId, openView]);

	// The session's workspace root, read off the framework session list
	// (same source the shipped Chat view uses). Undefined until the
	// session summary carries its cwd; until then the view is in-memory.
	const cwd = useSessions((s) => {
		if (!s || !s.byId) return undefined;
		const entry = s.byId[sessionId];
		return entry ? entry.cwd : undefined;
	});
	cwdRef.current = cwd;
	sessionIdRef.current = sessionId;
	// Workspace sessions offered as "Send to session…" targets (same cwd,
	// excluding this session and subagent rows). Empty constants keep the
	// selector results stable across snapshots.
	const sessionRows = useSessions((s) => (s && s.byId) || EMPTY_ROWS);
	const workspaceItems = useWorkspaces
		? useWorkspaces((s) => (s && s.items) || EMPTY_ITEMS)
		: EMPTY_ITEMS;

	React.useEffect(() => () => {
		// Unmount (leaving the canvas, panel close): the run itself keeps going
		// server-side; the stream is simply detached. A remount re-discovers it.
		if (sseRef.current !== null) { sseRef.current.close(); sseRef.current = null; }
	}, []);

	// A menu whose agent vanished (Delete key, toolbar Delete, Clear) has
	// nothing left to act on — close it.
	React.useEffect(() => {
		if (nodeMenu !== null && !agents.some((a) => a.id === nodeMenu.agentId)) setNodeMenu(null);
	}, [agents, nodeMenu]);

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
	// Per-port anchor points (edge-routing iteration 2): each port renders on
	// its declared node edge — inputs default left, outputs default right, and
	// an explicit side may place a port on the top or bottom edge so a loop
	// arcs over or under the band. Several ports resolving to one side
	// (validateGraph flags the overlap) stack along that side's axis.
	type Side = PortSide;
	const SIDE_NORMAL: Record<Side, { x: number; y: number }> = {
		left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
	};
	// A hand-edited file can carry a side validateGraph rejects — render it as
	// the side default instead of producing NaN anchors.
	function asSide(value: unknown): Side | null {
		return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
	}
	function inputPortSide(a: CanvasAgent, port: string): Side {
		const spec = Array.isArray(a.inputPorts) ? a.inputPorts.find((p) => p != null && p.name === port) : undefined;
		return asSide(spec?.side) ?? "left";
	}
	function outputPortSide(a: CanvasAgent, port: string): Side {
		return asSide(a.outputPortSides?.[port]) ?? "right";
	}
	function portAnchor(a: CanvasAgent, kind: "in" | "out", port: string): { x: number; y: number; side: Side } {
		const sideOf = (n: string) => (kind === "in" ? inputPortSide(a, n) : outputPortSide(a, n));
		const side = sideOf(port);
		const sameSide = (kind === "in" ? inputPortNamesOf(a.id) : outputPortNamesOf(a.id)).filter((n) => sideOf(n) === side);
		const frac = (Math.max(0, sameSide.indexOf(port)) + 1) / (sameSide.length + 1);
		if (side === "left") return { x: a.x, y: a.y + NODE_H * frac, side };
		if (side === "right") return { x: a.x + NODE_W, y: a.y + NODE_H * frac, side };
		if (side === "top") return { x: a.x + NODE_W * frac, y: a.y, side };
		return { x: a.x + NODE_W * frac, y: a.y + NODE_H, side };
	}

	// node drag (pointer capture on the node). Primary button only: a
	// right-button press must not drag the node — it opens the context menu.
	function onNodePointerDown(e: React.PointerEvent, agent: CanvasAgent) {
		if (e.button !== 0) return;
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

	// connect output -> input (primary button only — a right-button press must
	// not draft a connection; the event bubbles to the node's context menu).
	// The grab remembers which output tick it started from so the picker can
	// default to it (edge-routing proposal 1).
	function onOutputPointerDown(e: React.PointerEvent, agent: CanvasAgent, port: string) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		if (canvasRef.current) canvasRef.current.focus();
		const p = canvasPoint(e.clientX, e.clientY);
		connectRef.current = { from: agent.id, cursor: { x: p.x, y: p.y }, hoverTarget: null, startPort: port };
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
				const conn = { id: newId("conn"), source: c.from, target };
				// Named ports (P7): when either endpoint declares several, the
				// edge must say which ones — the picker completes it. A node
				// with a single (or default) port wires without ceremony. The
				// grabbed output tick defaults the source side.
				const srcPorts = outputPortNamesOf(c.from);
				const sourcePort = c.startPort && srcPorts.includes(c.startPort) ? c.startPort : srcPorts[0];
				const tgtPorts = inputPortNamesOf(target);
				if (srcPorts.length > 1 || tgtPorts.length > 1) {
					setEdgeDraft({ ...conn, sourcePort, targetPort: tgtPorts[0] });
				} else {
					setConnections((prev) => prev.concat([{
						...conn,
						...(sourcePort !== "out" ? { sourcePort } : {}),
						...(tgtPorts[0] !== "in" ? { targetPort: tgtPorts[0] } : {}),
					}]));
				}
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
		setRunResult(null); setResultOpen(false); setShowRunModal(false); setDoneRun(null);
		setNodeMenu(null);
		runTextRef.current = ""; runFilesRef.current = [];
	}

	// ---- Node context menu ----------------------------------------------------
	// Right-click a node: select it and open the harness Menu at the pointer
	// (native menu suppressed on nodes only — the canvas background keeps it).
	// Entries are the pinned shape, headed by Go to transcript — enabled once
	// the projection holds a child session for the node (live, paused, and
	// restored-last-run records all project one; a never-fired node shows the
	// row disabled, and disabled rows never dispatch).
	function onNodeContextMenu(e: React.MouseEvent, agent: CanvasAgent) {
		e.preventDefault(); e.stopPropagation();
		setSelectedId(agent.id);
		// A connection gesture owns the pointer; it keeps its cancel path
		// (Escape) and the right-click opens nothing.
		if (connectRef.current) return;
		setNodeMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
	}
	function nodeMenuEntries(agent: CanvasAgent): MenuEntry[] {
		const childSessionId = runProjection?.nodes[agent.id]?.childSessionId;
		return [
			{ id: "transcript", label: "Go to transcript", disabled: typeof childSessionId !== "string" || childSessionId.length === 0 },
			{ type: "separator", id: "menu-sep-edit" },
			{ id: "edit", label: "Edit agent" },
			{ id: "breakpoint", label: agent.breakpoint ? "Disarm breakpoint" : "Arm breakpoint" },
			{ type: "separator", id: "menu-sep-delete" },
			{ id: "delete", label: "Delete agent", danger: true },
		];
	}
	function runNodeMenuAction(id: string) {
		if (nodeMenu === null) return;
		const agentId = nodeMenu.agentId;
		if (id === "edit") {
			setConfigAgentId(agentId);
		} else if (id === "breakpoint") {
			// Same toggle the node's breakpoint button performs.
			setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, breakpoint: !a.breakpoint } : a)));
		} else if (id === "delete") {
			// Same removal as deleteSelected: the node plus its connections.
			setAgents((prev) => prev.filter((a) => a.id !== agentId));
			setConnections((prev) => prev.filter((c) => c.source !== agentId && c.target !== agentId));
			if (selectedId === agentId) setSelectedId(null);
		} else if (id === "transcript") {
			// Re-read at dispatch — the projection may have moved since open.
			// The wrapper closes the menu before this runs.
			const childSessionId = runProjection?.nodes[agentId]?.childSessionId;
			if (typeof childSessionId === "string" && childSessionId.length > 0) openTranscript(childSessionId);
		}
	}

	// ---- Durable run lifecycle ----------------------------------------------
	// An active run is anything the Host reports as running or paused; the
	// canvas shows its per-node states, the Abort button, and (while a run is
	// active) an "editing affects the next run" hint. The immutable snapshot
	// was taken at POST time — canvas edits never touch the in-flight run.

	const runActive = activeRun !== null && (activeRun.state === "running" || activeRun.state === "paused");
	// The record is a firing log; the per-node view is computed, never stored.
	// While a run is active its live projection drives the nodes; otherwise the
	// last terminal record does (restored after a remount), so finished nodes
	// keep their statuses. pausedAt points at a FIRING; the projection resolves
	// it to its node and derives the pending-pause queue (head first) — several
	// breakpoints may be parked at once, and the modal/label surface the head
	// plus the depth.
	const runProjection = runActive && activeRun !== null
		? projectNodes(activeRun)
		: doneRun !== null ? projectNodes(doneRun) : null;
	const pausedNodeId = runActive && activeRun?.state === "paused" ? runProjection?.pausedNodeId ?? null : null;
	// Fail-fast (P6): the failed firing commits while the run is still draining
	// its in-flight siblings — surface it live on the banner (the node chip
	// shows the error status through the same projection).
	const failedNodeId = runActive && runProjection !== null
		? runProjection.order.find((id) => runProjection.nodes[id]?.status === "error") ?? null
		: null;
	// A resolved paused node always heads the projection's queue, so the depth
	// behind it is length − 1.
	const queuedCount = pausedNodeId !== null && runProjection ? runProjection.pausedQueue.length - 1 : 0;
	const inspectOpen = pausedNodeId !== null
		&& activeRun !== null
		&& typeof activeRun.runId === "string"
		&& inspectDismissedFor !== (activeRun.runId + ":" + (activeRun.pausedAt ?? pausedNodeId));

	function disconnectRunEvents() {
		if (sseRef.current !== null) { sseRef.current.close(); sseRef.current = null; }
	}

	function connectRunEvents(runId: string) {
		disconnectRunEvents();
		if (typeof cwdRef.current !== "string" || cwdRef.current.length === 0) return;
		const source = new EventSource(ENDPOINT + "/run/events?id=" + encodeURIComponent(runId) + "&cwd=" + encodeURIComponent(cwdRef.current));
		sseRef.current = source;
		const onRecord = (event: MessageEvent<string>) => {
			let rec: RunRecordLike | null = null;
			try { rec = JSON.parse(event.data) as RunRecordLike; } catch { rec = null; }
			if (rec === null || typeof rec !== "object") return;
			adoptRecord(rec);
		};
		source.addEventListener("snapshot", onRecord as EventListener);
		source.addEventListener("update", onRecord as EventListener);
		// Errors (a profile restart dropped the stream) are healed by
		// EventSource's automatic reconnect: the fresh snapshot re-syncs state.
	}

	// Fold one record transition into the view: keep it while active; on a
	// terminal state, detach the stream, re-enable the Run button, and open
	// the result modal with the per-node statuses and terminal outputs.
	function adoptRecord(rec: RunRecordLike) {
		const state = rec.state;
		if (state === "running" || state === "paused") {
			setActiveRun(rec);
			return;
		}
		disconnectRunEvents();
		setActiveRun(null);
		setDoneRun(rec);
		setRunResult(recordToResult(rec));
		setResultOpen(true);
		// Terminal transition opens the result modal; the menu's host-styled
		// portal layers above modals, so it must go rather than stack.
		setNodeMenu(null);
	}

	// Terminal record → the result modal's shape: the contract outputs keyed by
	// terminal id (only agents that produced an output) plus per-agent statuses,
	// all through the projection (the record itself is a firing log). The rows
	// walk the snapshot's topological order so never-started agents still list
	// as "pending" — the projection only knows nodes that fired. `list`
	// overrides the current canvas agents for the label lookup — the load path
	// calls this before the parsed agents have landed in state.
	function recordToResult(rec: RunRecordLike, list?: CanvasAgent[]): RunResultLike {
		const nameIn = (id: string): string => {
			for (const a of list ?? agents) if (a.id === id) return a.name;
			return id;
		};
		const projection = projectNodes(rec);
		const runs = topoOrder(rec.graph).map((id) => {
			const node = projection.nodes[id];
			return {
				id,
				label: nameIn(id),
				status: node?.status ?? "pending",
				...(node?.error ? { error: node.error } : {}),
				...(node?.childSessionId ? { childSessionId: node.childSessionId } : {}),
			};
		});
		if (rec.state === "error") {
			return { ok: false, error: "The run failed — see the per-agent statuses below.", runs };
		}
		const terminals = classifyGraph(rec.graph).terminals;
		const outputs: Record<string, unknown> = {};
		for (const id of terminals) {
			const output = projection.nodes[id]?.output;
			if (typeof output === "string") outputs[id] = output;
		}
		return { ok: true, outputs, runs, ...(rec.state === "aborted" ? { aborted: true } : {}) };
	}

	// Start a durable run: POST the snapshot the user currently shows (plus the
	// composed pipeline input, the optional concurrency cap, and the workspace
	// root) and subscribe to the run's SSE stream. The Host validates, enforces
	// the single-active-run rule (409 with the other run's id), and returns the
	// runId immediately.
	function run(text: string, files: string[], maxInFlight: number | null) {
		if (runActive || startPending) return;
		runTextRef.current = text;
		runFilesRef.current = files;
		const workspace = cwdRef.current;
		if (typeof workspace !== "string" || workspace.length === 0) {
			setRunResult({ ok: false, error: "the pipeline's workspace root is not known yet — reopen this view and try again" });
			setResultOpen(true);
			return;
		}
		const g = buildGraph(agents, connections);
		setStartPending(true);
		setRunResult(null);
		setDoneRun(null);
		setShowRunModal(false);
		setInspectDismissedFor(null);
		setControlStatus(null);
		fetch(ENDPOINT + "/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId,
				cwd: workspace,
				graph: g,
				input: composePipelineInput(text, files),
				...(maxInFlight !== null ? { maxInFlight } : {}),
			}),
		})
			.then(async (r) => {
				let data: { ok?: unknown; runId?: unknown; error?: unknown; activeRunId?: unknown } | null = null;
				try { data = await r.json(); } catch { data = null; }
				if (!r.ok || data === null || data.ok !== true || typeof data.runId !== "string") {
					const detail = typeof data?.error === "string" ? data.error : "HTTP " + r.status;
					const other = typeof data?.activeRunId === "string" ? ` (run ${data.activeRunId.slice(0, 8)}…)` : "";
					throw new Error(detail + other);
				}
				return data.runId;
			})
			.then((runId) => {
				// The start may resolve after a session switch (the load-effect
				// reset has already run by then): the run belongs to the session
				// it was started from, so the other session's view must neither
				// follow its stream nor surface its failure.
				if (sessionIdRef.current !== sessionId) return;
				connectRunEvents(runId);
			})
			.catch((err: unknown) => {
				if (sessionIdRef.current !== sessionId) return;
				setRunResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
				setResultOpen(true);
			})
			.finally(() => { setStartPending(false); });
	}

	// Send a control command for the active run (resume / rerun / steer /
	// abort). State transitions come back through the SSE stream; a typed
	// error is surfaced inline in the modal that issued the command.
	async function controlRun(action: "resume" | "rerun" | "steer" | "abort", feedback?: string) {
		const rec = activeRun;
		const workspace = cwdRef.current;
		if (!rec || typeof rec.runId !== "string" || typeof workspace !== "string") return;
		setControlBusy(action);
		setControlStatus(null);
		try {
			const r = await fetch(ENDPOINT + "/control", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ runId: rec.runId, cwd: workspace, action, ...(feedback !== undefined ? { feedback } : {}) }),
			});
			let data: { ok?: unknown; error?: unknown } | null = null;
			try { data = await r.json(); } catch { data = null; }
			if (!r.ok || data === null || data.ok !== true) {
				throw new Error(typeof data?.error === "string" ? data.error : "HTTP " + r.status);
			}
		} catch (err) {
			setControlStatus(err instanceof Error ? err.message : String(err));
		} finally {
			setControlBusy(null);
		}
	}

	// Open one agent's durable child session (the run's transcript). Navigating
	// to another session unmounts this view and drops the live view of the run —
	// that is the accepted cost of every route that leaves the canvas; the run
	// itself continues server-side. The child may remember this canvas as its
	// tab (the view store is per session), so a chat request is stashed for the
	// instance that mounts under the child — otherwise the user lands on the
	// same canvas again and never sees the transcript. When THIS canvas already
	// is the target (a child's own row, viewed from its canvas), no navigation
	// remounts anything — this instance's openView is the direct write path.
	function openTranscript(childSessionId: string) {
		if (childSessionId === sessionId) {
			if (typeof openView === "function") openView("chat", "");
			else if (onDismiss) onDismiss();
			return;
		}
		const sessions = services && services.sessions;
		if (sessions && typeof sessions.open === "function") {
			requestChatView(childSessionId);
			sessions.open(childSessionId);
		}
		if (onDismiss) onDismiss();
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

	// ---- Named ports (P7) ----------------------------------------------------
	// Edges carry PORT NAMES ("mail → data"); default graphs keep the implicit
	// "out"/"in". The name lists come from the declared port lists, falling
	// back to the single default port when undeclared.

	/** The node's output port names (declared, else the single "out"). */
	function outputPortNamesOf(id: string): string[] {
		const a = agents.find((x) => x.id === id);
		return a && Array.isArray(a.outputPorts) && a.outputPorts.length > 0 ? a.outputPorts : ["out"];
	}
	/** The node's input port names (declared, else the single "in"). */
	function inputPortNamesOf(id: string): string[] {
		const a = agents.find((x) => x.id === id);
		return a && Array.isArray(a.inputPorts) && a.inputPorts.length > 0 ? a.inputPorts.map((p) => p.name) : ["in"];
	}
	/** The port NAME a persisted wire id carries ("<agentId>:<name>" → name). */
	function portNameOf(wire: unknown, agentId: string, fallback: string): string {
		const s = String(wire ?? "");
		return s.startsWith(agentId + ":") ? s.slice(agentId.length + 1) : fallback;
	}
	/** Complete a drafted connection with the picked port names. */
	function confirmEdgeDraft() {
		const d = edgeDraft;
		if (!d) return;
		setEdgeDraft(null);
		setConnections((prev) => prev.concat([{
			id: d.id,
			source: d.source,
			target: d.target,
			// Default names stay unwritten — buildGraph composes the same wire id.
			...(d.sourcePort !== "out" ? { sourcePort: d.sourcePort } : {}),
			...(d.targetPort !== "in" ? { targetPort: d.targetPort } : {}),
		}]));
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
			const uiWorkspace = services && services.uiWorkspace;
			// Resolve the workspace the new chat must attach to: the pipeline's
			// own folder (cwd) first — the chat belongs to the repo the pipeline
			// ran on — then the session's workspace. `connectWorkspace` creates
			// (or reuses the blank session of) a workspace-attached session, so
			// it lands in `workspace.sessionIds` and shows in the sidebar. A
			// cwd-only `sessions.create` would create an orphan the sidebar
			// tree can never render, so there is deliberately NO such fallback.
			const ws = (cwd ? workspaceItems.find((w) => w.path === cwd) : undefined)
				|| workspaceItems.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1);
			if (!ws || typeof ws.workspaceId !== "string" || !uiWorkspace || typeof uiWorkspace.connectWorkspace !== "function") {
				throw new Error("this pipeline's folder is not a connected workspace — connect the folder in the sidebar first");
			}
			const newId = await uiWorkspace.connectWorkspace(ws.workspaceId);
			if (typeof newId !== "string" || newId.length === 0) throw new Error("no session could be created for this workspace");
			const sessions = services && services.sessions;
			if (sessions && typeof sessions.open === "function") {
				requestChatView(newId);
				sessions.open(newId);
			}
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
			if (sessions && typeof sessions.open === "function") {
				requestChatView(targetId);
				sessions.open(targetId);
			}
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

	// Load the saved graph once the workspace root is known, scoped to THIS
	// session (the Host falls back to the legacy workspace file while the
	// session has none). The response's `run` field re-discovers the session's
	// active run after a page reload (the SSE stream is re-attached; a paused
	// run's inspection modal reopens).
	//
	// The effect refires on a session switch (the shell panel stays mounted
	// across switches), so (re)entry first drops the per-run view state the
	// previous session left behind: its SSE stream (events for the old run
	// must never land in the new session's view), the active/terminal records
	// and with them the result modal (the previous session's `resultOpen`
	// must not pop the new session's restored lastRun open), a pending
	// debounced save (a timer scheduled for the old session would write the
	// OLD graph into the NEW session's file — the callback reads stateRef at
	// fire time), and a node menu anchored to ids the new graph may reuse.
	React.useEffect(() => {
		disconnectRunEvents();
		setActiveRun(null);
		setDoneRun(null);
		setRunResult(null);
		setResultOpen(false);
		setNodeMenu(null);
		if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
		if (typeof cwd !== "string" || cwd.length === 0) return;
		let cancelled = false;
		fetch(ENDPOINT + "?cwd=" + encodeURIComponent(cwd)
			+ (sessionId.length > 0 ? "&sessionId=" + encodeURIComponent(sessionId) : ""), { cache: "no-store" })
			.then((r) => r.json())
			.then((data) => {
				if (cancelled) return;
				const p = data && data.ok === true ? data.pipeline : null;
				const as = p && Array.isArray(p.agents) ? p.agents : [];
				const cs = p && Array.isArray(p.connections) ? p.connections : [];
				skipNextPersistRef.current = true;
				loadedRef.current = true;
				const loaded = as.map((a: unknown) => {
					const load = loadAgent(a);
					const r = (a ?? {}) as { id?: unknown; name?: unknown; description?: unknown; instructions?: unknown; x?: unknown; y?: unknown; breakpoint?: unknown };
					return {
						id: String(r.id), name: String(r.name), description: String(r.description || ""),
						...(load.systemPrompt.length > 0 ? { systemPrompt: load.systemPrompt } : {}),
						instructions: String(r.instructions || ""),
						x: Number(r.x) || 0, y: Number(r.y) || 0,
						...(load.inputPorts !== undefined ? { inputPorts: load.inputPorts } : {}),
						...(load.outputPorts !== undefined ? { outputPorts: load.outputPorts } : {}),
						...(load.outputPortSides !== undefined ? { outputPortSides: load.outputPortSides } : {}),
						...(load.bindings !== undefined ? { bindings: load.bindings } : {}),
						settings: load.settings,
						...(r.breakpoint === true ? { breakpoint: true } : {}),
					};
				});
				setAgents(loaded);
				setConnections(cs.map((c: { id: unknown; source: unknown; target: unknown; sourcePort?: unknown; targetPort?: unknown }) => {
					const source = String(c.source);
					const target = String(c.target);
					return {
						id: String(c.id), source, target,
						// The wire ids carry the port names ("<agentId>:<name>");
						// the reverse of buildGraph keeps named-port wiring
						// editable on the canvas across a reload.
						sourcePort: portNameOf(c.sourcePort, source, "out"),
						targetPort: portNameOf(c.targetPort, target, "in"),
					};
				}));
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
				// Discovery: adopt the workspace's active run (if any) and follow it.
				const active = data && data.ok === true && data.run !== null && typeof data.run === "object" ? data.run as RunRecordLike : null;
				if (active !== null && (active.state === "running" || active.state === "paused") && typeof active.runId === "string") {
					setActiveRun(active);
					connectRunEvents(active.runId);
				} else {
					// Nothing active: restore the last run's outcome from the GET's
					// `lastRun` so the Result button and the per-node statuses
					// survive leaving and re-entering the view. The modal stays
					// closed — the user closed it deliberately.
					const last = data && data.ok === true && data.lastRun !== null && typeof data.lastRun === "object"
						? data.lastRun as RunRecordLike
						: null;
					if (last !== null && last.state !== "running" && last.state !== "paused") {
						setDoneRun(last);
						setRunResult(recordToResult(last, loaded));
					}
				}
			})
			.catch(() => { loadedRef.current = true; });
		return () => { cancelled = true; };
	}, [cwd, sessionId]);

	// Persist on every graph change (debounced so an in-progress drag
	// coalesces into one write). A freshly-loaded graph is not written back
	// immediately (skipNextPersist consumed once). The save is keyed to the
	// session — the fork: with a session id the Host writes THAT session's own
	// file (`.agent-pipeline/pipelines/<id>.json`) and leaves the legacy
	// workspace graph untouched; without one it keeps the legacy cwd-only
	// write. Both scopes read off the refs at save time.
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
				body: JSON.stringify({
					cwd: cwdRef.current,
					...(sessionIdRef.current.length > 0 ? { sessionId: sessionIdRef.current } : {}),
					graph: g,
				}),
			}).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [agents, connections]);

	const gesture = connectRef.current;
	// Edge geometry (edge-routing iteration 2): the path leaves perpendicular
	// to the source port's edge and arrives perpendicular to the target port's
	// edge (60px control offset), so top/bottom ports arc over/under the band
	// and left/right ports keep the classic S-curve. One fallback keeps
	// iteration 1's lane rule: a wire whose ends are BOTH on horizontal edges
	// and whose target sits left of its source routes through a lane below the
	// node band instead of a flat back-and-forth S.
	const EDGE_OFF = 60;
	const BRACKET_CLEAR = 30;
	const BRACKET_R = 8;
	// The tick renders 14px + a 2px border (content-box) — its rim sits 9px
	// from the anchor. Arrow paths stop TICK_R + HEAD_CLEAR short of the
	// anchor so the head lands just off the rim, never under the dot.
	const TICK_R = 9;
	const HEAD_CLEAR = 2;
	function edgeGeometry(
		s: { x: number; y: number; side: Side },
		t: { x: number; y: number; side: Side },
	): { d: string; mx: number; my: number } {
		// Same-side vertical ports route as an orthogonal bracket: out of the
		// port, along a lane past the node band, and straight back into the
		// port's own axis — the arrowhead lands on that final vertical run
		// (a bezier curling into a vertical port reads badly at the tip).
		if (s.side === t.side && (s.side === "top" || s.side === "bottom")) {
			const down = s.side === "bottom";
			const vdir = down ? 1 : -1;
			const lane = down ? Math.max(s.y, t.y) + BRACKET_CLEAR : Math.min(s.y, t.y) - BRACKET_CLEAR;
			const endY = t.y + vdir * (TICK_R + HEAD_CLEAR);
			const sx = Math.sign(t.x - s.x);
			const r = Math.min(BRACKET_R, Math.abs(t.x - s.x) / 2, Math.abs(lane - s.y), Math.abs(lane - endY));
			let d: string;
			if (!Number.isFinite(r) || r < 1 || sx === 0) {
				// Nodes nearly aligned: sharp corners (or a straight drop).
				d = "M" + s.x + " " + s.y + " L" + s.x + " " + lane + " L" + t.x + " " + lane + " L" + t.x + " " + endY;
			} else {
				d = "M" + s.x + " " + s.y
					+ " L" + s.x + " " + (lane - vdir * r)
					+ " Q" + s.x + " " + lane + " " + (s.x + sx * r) + " " + lane
					+ " L" + (t.x - sx * r) + " " + lane
					+ " Q" + t.x + " " + lane + " " + t.x + " " + (lane - vdir * r)
					+ " L" + t.x + " " + endY;
			}
			// Label rides the bracket's horizontal run (above it for a bottom
			// lane, below it for a top lane).
			return { d, mx: (s.x + t.x) / 2, my: down ? lane - 5 : lane + 14 };
		}
		// Everything else: leave perpendicular to the source edge, arrive
		// perpendicular to the target edge. One fallback keeps iteration 1's
		// lane rule: a wire whose ends are BOTH on horizontal edges and whose
		// target sits left of its source routes through a lane below the node
		// band instead of a flat back-and-forth S.
		const n1 = SIDE_NORMAL[s.side], n2 = SIDE_NORMAL[t.side];
		let c1: { x: number; y: number }, c2: { x: number; y: number };
		if (n1.y === 0 && n2.y === 0 && t.x < s.x - 1) {
			const lane = Math.max(s.y, t.y) + NODE_H / 2 + 46;
			c1 = { x: s.x + EDGE_OFF, y: lane };
			c2 = { x: t.x - EDGE_OFF, y: lane };
		} else {
			c1 = { x: s.x + n1.x * EDGE_OFF, y: s.y + n1.y * EDGE_OFF };
			c2 = { x: t.x + n2.x * EDGE_OFF, y: t.y + n2.y * EDGE_OFF };
		}
		// Stop short of the anchor: the port tick renders above the edge layer,
		// so a path ending at the anchor buries the arrowhead under the dot.
		// End on the rim instead — tick radius + a hair of clearance — along
		// the arrival direction (c2 -> anchor).
		const arrX = t.x - c2.x, arrY = t.y - c2.y;
		const arrLen = Math.hypot(arrX, arrY);
		const head = TICK_R + HEAD_CLEAR;
		const ex = arrLen > head ? t.x - (arrX / arrLen) * head : t.x;
		const ey = arrLen > head ? t.y - (arrY / arrLen) * head : t.y;
		const d = "M" + s.x + " " + s.y + " C" + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + ex + " " + ey;
		// Exact cubic midpoint of the full curve — the label rides the curve.
		const mx = (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8;
		const my = (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 - 6;
		return { d, mx, my };
	}
	const edges = connections.map((c) => {
		let src: CanvasAgent | null = null, tgt: CanvasAgent | null = null;
		for (let i = 0; i < agents.length; i++) {
			if (agents[i].id === c.source) src = agents[i];
			if (agents[i].id === c.target) tgt = agents[i];
		}
		if (!src || !tgt) return null;
		const sourceName = c.sourcePort ?? "out";
		const targetName = c.targetPort ?? "in";
		const s = portAnchor(src, "out", sourceName);
		const t = portAnchor(tgt, "in", targetName);
		// A non-default port name is labeled at the edge midpoint — the canvas
		// shows the real dataflow (design principle 2). A quiet port (its
		// binding simply never matched) needs no extra rendering: an edge is
		// only labeled wiring, never a promise the message arrived.
		const labeled = sourceName !== "out" || targetName !== "in";
		const geo = edgeGeometry(s, t);
		return (
			<g key={c.id}>
				<path d={geo.d} className="pipeline-edge" markerEnd="url(#pipeline-arrow)" />
				{labeled ? (
					<text x={geo.mx} y={geo.my} className="pipeline-edge-label" textAnchor="middle">
						{sourceName + " → " + targetName}
					</text>
				) : null}
			</g>
		);
	});
	let tempEdge: React.ReactNode = null;
	if (gesture) {
		let src0: CanvasAgent | null = null;
		for (let j = 0; j < agents.length; j++) if (agents[j].id === gesture.from) src0 = agents[j];
		if (src0) {
			const s0 = portAnchor(src0, "out", gesture.startPort ?? "out");
			const cx = gesture.cursor ? gesture.cursor.x : s0.x;
			const cy = gesture.cursor ? gesture.cursor.y : s0.y;
			tempEdge = <path d={edgeGeometry(s0, { x: cx, y: cy, side: "left" }).d} className="pipeline-edge-temp" />;
		}
	}

	const nodes = agents.map((agent) => {
		const selected = agent.id === selectedId;
		const hoveredIn = hoverTarget === agent.id && gesture;
		const nodeState = runProjection !== null ? runProjection.nodes[agent.id] : undefined;
		const status = nodeState?.status;
		const showStatus = status !== undefined && status !== "pending";
		return (
			<div
				key={agent.id}
				className={"pipeline-node" + (selected ? " selected" : "") + (showStatus && status ? " node-" + status : "")}
				style={{ left: agent.x + "px", top: agent.y + "px" }}
				data-agent-id={agent.id}
				data-node-status={status ?? ""}
				onPointerDown={(e) => { onNodePointerDown(e, agent); }}
				onPointerMove={onNodePointerMove}
				onPointerUp={onNodePointerUp}
				onContextMenu={(e) => { onNodeContextMenu(e, agent); }}
			>
				<button
					className={"node-breakpoint" + (agent.breakpoint ? " armed" : "")}
					title={agent.breakpoint
						? "Breakpoint armed — the run pauses after this agent finishes (click to disarm)"
						: "Arm a breakpoint — pause the run after this agent finishes"}
					aria-label={(agent.breakpoint ? "Disarm breakpoint on " : "Arm breakpoint on ") + agent.name}
					onPointerDown={(e) => { e.stopPropagation(); }}
					onClick={(e) => {
						e.stopPropagation();
						setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, breakpoint: !a.breakpoint } : a)));
					}}
				>
					<svg width={10} height={10} viewBox="0 0 24 24" aria-hidden="true">
						<circle cx={12} cy={12} r={8} fill="currentColor" />
					</svg>
				</button>
				<button
					className="node-edit"
					title="Edit agent"
					aria-label={"Edit agent " + agent.name}
					// Keep the button's pointer events off the node's drag handler.
					onPointerDown={(e) => { e.stopPropagation(); }}
					onClick={(e) => { e.stopPropagation(); setConfigAgentId(agent.id); }}
				>
					<svg width={10} height={10} viewBox="0 0 24 24" aria-hidden="true">
						<path
							d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"
							fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
						/>
					</svg>
				</button>
				<div className="node-name">{agent.name}</div>
				<div className="node-sub">{agent.id}</div>
				{showStatus ? <div className={"node-status status-" + status}>{status}</div> : null}
				{inputPortNamesOf(agent.id).map((portName) => {
					const anchor = portAnchor(agent, "in", portName);
					const multiple = inputPortNamesOf(agent.id).length > 1 || anchor.side !== "left";
					return (
						<div
							key={portName}
							className={"pipeline-port in" + (hoveredIn ? " hover" : "")}
							style={{ left: (anchor.x - agent.x) + "px", top: (anchor.y - agent.y) + "px" }}
							onPointerEnter={(e) => { onInputPointerEnter(e, agent); }}
							onPointerLeave={(e) => { onInputPointerLeave(e, agent); }}
							// The port only swallows the primary press (nothing to do —
							// connections start at the output); a right-button press goes
							// unhandled so it bubbles to the node and opens the menu.
							onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); }}
							title={multiple ? portName : "Input"}
						/>
					);
				})}
				{outputPortNamesOf(agent.id).map((portName) => {
					const anchor = portAnchor(agent, "out", portName);
					const multiple = outputPortNamesOf(agent.id).length > 1 || anchor.side !== "right";
					return (
						<div
							key={portName}
							className="pipeline-port out"
							style={{ left: (anchor.x - agent.x) + "px", top: (anchor.y - agent.y) + "px" }}
							onPointerDown={(e) => { onOutputPointerDown(e, agent, portName); }}
							title={multiple ? portName : "Output"}
						/>
					);
				})}
			</div>
		);
	});

	const graphData = buildGraph(agents, connections);
	const validation: ValidationResult = validateGraph(graphData);
	const warnCount = validation.warnings?.length ?? 0;
	const jsonText = JSON.stringify(graphData, null, 2);

	let configAgent: CanvasAgent | null = null;
	for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];

	// The context menu's entries re-compute per its agent, so the breakpoint
	// label always reflects the live state; while the agent is mid-vanish
	// (before the close effect lands) the list simply renders empty.
	let menuAgent: CanvasAgent | null = null;
	if (nodeMenu !== null) {
		for (let m = 0; m < agents.length; m++) if (agents[m].id === nodeMenu.agentId) menuAgent = agents[m];
	}
	const menuEntries: readonly MenuEntry[] = menuAgent !== null ? nodeMenuEntries(menuAgent) : [];

	const inspectNode: ProjectedNode | undefined = pausedNodeId !== null && runProjection ? runProjection.nodes[pausedNodeId] : undefined;

	return (
		<div
			className="pipeline-view"
			onPointerMove={onContainerPointerMove}
			onPointerUp={onContainerPointerUp}
			onPointerLeave={onContainerPointerLeave}
		>
			<div className="pipeline-toolbar">
				<h3>Agent Pipeline</h3>
				<div className="spacer" />
				<span className="stat">{agents.length + " agents · " + connections.length + " connections"}</span>
				<span
					className={"pipeline-validation" + (validation.ok ? (warnCount > 0 ? " warn" : " ok") : " err")}
					title={validation.ok
						? (warnCount > 0 ? "Graph is valid — " + warnCount + " warning" + (warnCount === 1 ? "" : "s") + " (see below)" : "Graph is valid")
						: "Graph has validation issues (see the issue list below)"}
					role="status"
				>
					{validation.ok
						? (warnCount > 0 ? "Valid · " + warnCount + " warning" + (warnCount === 1 ? "" : "s") : "Valid")
						: validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")}
				</span>
				{runActive ? (
					<span
						className={"pipeline-run-live" + (failedNodeId !== null ? " failed" : "")}
						title={failedNodeId !== null
							? "A firing failed — the run ends after the in-flight agents finish; completed outputs are preserved"
							: "A run is active in this workspace — canvas edits affect the NEXT run only"}
					>
						{failedNodeId !== null
							? "Failed at " + nameOf(failedNodeId) + " — finishing in-flight agents…"
							: activeRun?.state === "paused"
								? "Paused at " + nameOf(pausedNodeId as string) + (queuedCount > 0 ? " +" + queuedCount + " queued" : "")
								: "Running…"}
					</span>
				) : null}
				<button className="pipeline-btn" onClick={addAgentFromToolbar}>+ Add Agent</button>
				<button className="pipeline-btn" onClick={deleteSelected} disabled={!selectedId}>Delete</button>
				<button className="pipeline-btn" onClick={() => { setShowJson(!showJson); }}>{showJson ? "Hide JSON" : "View JSON"}</button>
				<button className="pipeline-btn" onClick={clearAll}>Clear</button>
				{runResult && !resultOpen ? (
					<button
						className="pipeline-btn"
						title="Reopen the last run's result"
						onClick={() => { setResultOpen(true); }}
					>Result</button>
				) : null}
				<button
					className="pipeline-btn pipeline-btn-run"
					disabled={runActive || startPending || !validation.ok}
					title={runActive ? "A run is already active in this workspace" : startPending ? "Starting the run…" : "Open the run dialog"}
					onClick={() => { setShowRunModal(true); }}
				>{runActive ? "Running…" : startPending ? "Starting…" : "Run"}</button>
				{runActive || startPending ? (
					<button
						className="pipeline-btn pipeline-btn-stop"
						title="Abort the run — completed outputs are preserved, downstream agents never start"
						disabled={startPending || controlBusy !== null}
						onClick={() => { controlRun("abort"); }}
					>Abort</button>
				) : null}
			</div>
			{validation.ok && warnCount === 0 ? null : (
				<div className={"pipeline-issues" + (validation.ok ? " warnings-only" : "")}>
					{validation.errors.map((err) => (
						<div key={err.code + ":" + err.message} className="pipeline-issue">{err.message}</div>
					))}
					{(validation.warnings ?? []).map((warn) => (
						<div key={warn.code + ":" + warn.message} className="pipeline-issue warn">{warn.message}</div>
					))}
				</div>
			)}
			<div className="pipeline-body">
				<div className="pipeline-palette">
					<div className="palette-title">Palette</div>
					<div
						className="palette-item"
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData("application/x-pipeline-agent", "agent");
							e.dataTransfer.effectAllowed = "copy";
						}}
					>
						<div className="palette-icon" />
						Agent
					</div>
				</div>
				<div
					className="pipeline-canvas"
					ref={canvasRef}
					tabIndex={0}
					onDragOver={handleDragOver}
					onDrop={handleCanvasDrop}
					onPointerDown={onCanvasPointerDown}
					onKeyDown={onKeyDown}
				>
					<svg className="pipeline-edges">
						<defs>
							<marker id="pipeline-arrow" markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto" markerUnits="strokeWidth">
								<path d="M0,0 L6,3 L0,6 Z" className="pipeline-arrowfill" />
							</marker>
						</defs>
						{edges}
						{tempEdge}
					</svg>
					{nodes}
					{agents.length === 0 ? <div className="pipeline-hint">Drag an Agent from the palette onto the canvas</div> : null}
				</div>
			</div>
			{showJson ? <div className="pipeline-json"><pre>{jsonText}</pre></div> : null}
			{configAgent ? (
				<AgentConfigPanel
					key={configAgent.id}
					agent={configAgent}
					onSave={(updated) => {
						setAgents((prev) => prev.map((a) =>
							a.id === updated.id
								? {
									...a,
									name: updated.name,
									description: updated.description,
									systemPrompt: updated.systemPrompt,
									instructions: updated.instructions,
									settings: updated.settings,
									// Port lists and bindings save as authored — an
									// emptied editor clears (undefined drops the
									// field from the persisted graph).
									inputPorts: updated.inputPorts,
									outputPorts: updated.outputPorts,
									outputPortSides: updated.outputPortSides,
									bindings: updated.bindings,
									...(updated.breakpoint === true ? { breakpoint: true } : { breakpoint: undefined }),
								}
								: a
						));
						setConfigAgentId(null);
					}}
					onClose={() => { setConfigAgentId(null); }}
				/>
			) : null}
			{edgeDraft ? (
				<div
					className="pipeline-config-overlay"
					onPointerDown={(e) => { e.stopPropagation(); }}
				>
					<div className="pipeline-edge-picker">
						<h3>Connect ports</h3>
						<div className="picker-row">
							<label>{"From " + nameOf(edgeDraft.source) + " (output port)"}</label>
							<select
								value={edgeDraft.sourcePort}
								onChange={(e) => { setEdgeDraft((d) => (d ? { ...d, sourcePort: e.target.value } : d)); }}
							>
								{outputPortNamesOf(edgeDraft.source).map((portName) => (
									<option key={portName} value={portName}>{portName}</option>
								))}
							</select>
						</div>
						<div className="picker-row">
							<label>{"To " + nameOf(edgeDraft.target) + " (input port)"}</label>
							<select
								value={edgeDraft.targetPort}
								onChange={(e) => { setEdgeDraft((d) => (d ? { ...d, targetPort: e.target.value } : d)); }}
							>
								{inputPortNamesOf(edgeDraft.target).map((portName) => (
									<option key={portName} value={portName}>{portName}</option>
								))}
							</select>
						</div>
						<div className="picker-actions">
							<button className="pipeline-btn" onClick={() => { setEdgeDraft(null); }}>Cancel</button>
							<button className="pipeline-btn" onClick={confirmEdgeDraft}>Connect</button>
						</div>
					</div>
				</div>
			) : null}
			{showRunModal ? (
				<RunModal
					cwd={cwd}
					initialText={runTextRef.current}
					initialFiles={runFilesRef.current}
					running={runActive || startPending}
					fileList={services && services.remote && services.remote.fileReferences ? queryFiles : null}
					onRun={run}
					onClose={() => { setShowRunModal(false); }}
				/>
			) : null}
			{inspectOpen && pausedNodeId !== null && inspectNode !== undefined && activeRun !== null ? (
				<InspectModal
					agentName={nameOf(pausedNodeId)}
					node={inspectNode}
					queued={queuedCount}
					busy={controlBusy}
					status={controlStatus}
					canSteer={typeof inspectNode.childSessionId === "string" && (inspectNode.childSessionId as string).length > 0}
					onOpenSession={openTranscript}
					onResume={() => { controlRun("resume"); }}
					onRerun={() => { controlRun("rerun"); }}
					onSteer={(feedback) => { controlRun("steer", feedback); }}
					onAbort={() => { controlRun("abort"); }}
					onClose={() => { setInspectDismissedFor((activeRun.runId ?? "") + ":" + (activeRun.pausedAt ?? pausedNodeId)); }}
				/>
			) : null}
			{runResult && resultOpen ? (
				<ResultModal
					result={runResult}
					names={agents.reduce<Record<string, string>>((acc, a) => { acc[a.id] = a.name; return acc; }, {})}
					targets={targets}
					busy={continueBusy}
					status={continueStatus}
					onOpenSession={openTranscript}
					onContinueChat={continueInChat}
					onContinueNewSession={continueInNewSession}
					onSendTo={sendToSession}
					onClose={() => { setResultOpen(false); setContinueStatus(null); }}
				/>
			) : null}
			{nodeMenu !== null ? (
				// The wrapper div swallows contextmenu over the open menu itself —
				// the portaled list must not surface the browser's native menu.
				<div onContextMenu={(e) => { e.preventDefault(); }}>
					<NodeMenu
						target={nodeMenu}
						entries={menuEntries}
						onAction={runNodeMenuAction}
						onClose={() => { setNodeMenu(null); }}
					/>
				</div>
			) : null}
		</div>
	);
}

export { PipelineView };
