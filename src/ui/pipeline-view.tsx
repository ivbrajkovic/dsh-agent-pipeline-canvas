// The Pipelines canvas view: the whole node workspace — a palette with a
// draggable Agent, a canvas, node move/select, the node edit button, the
// breakpoint toggle, output→input connections with directed edges, the toolbar
// (add/delete/JSON/clear/run/abort), load/save through the Host routes, the
// run/result modals, and the paused-run inspection modal. Renders inside the
// per-session view tab AND the frame-wide shell panel (see ./shell-panel.tsx);
// the two hosts differ only in the props below.
//
// Running is DURABLE: the Run dialog POSTs the snapshot to the Host's /run
// route, which starts a run executor in the Host process and returns a runId
// immediately (one active run per workspace — a 409 reports the other run).
// The view then follows the run's record over SSE (snapshot on connect/reconnect,
// update per transition); EventSource's auto-reconnect self-heals a profile
// restart. When the record pauses at a breakpointed agent, the inspection modal
// opens with the composed input, the adopted output, and the control actions
// (Resume / Rerun / Steer / Abort). On a terminal state (completed / aborted /
// error) the result modal opens. A page reload re-discovers the active run via
// the pipeline GET's `run` field and re-subscribes — runs outlive the tab.
import * as React from "react";
import { validateGraph } from "../graph.ts";
import { classifyGraph, topoOrder } from "../execution.ts";
import { projectNodes, type ProjectedNode } from "../projection.ts";
import { composePipelineInput, finalOutputText } from "../message.ts";
import type { ValidationResult } from "../types.ts";
import { AgentConfigPanel } from "./agent-config.tsx";
import { RunModal } from "./run-modal.tsx";
import { ResultModal } from "./result-modal.tsx";
import { InspectModal } from "./inspect-modal.tsx";
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
	const [continueBusy, setContinueBusy] = React.useState<string | null>(null);
	const [continueStatus, setContinueStatus] = React.useState<string | null>(null);
	// The paused-run inspection modal: closed per (run, agent) by the user.
	const [inspectDismissedFor, setInspectDismissedFor] = React.useState<string | null>(null);
	const [controlBusy, setControlBusy] = React.useState<string | null>(null);
	const [controlStatus, setControlStatus] = React.useState<string | null>(null);
	const runTextRef = React.useRef("");
	const runFilesRef = React.useRef<string[]>([]);
	/** The live SSE subscription for the active run's record. */
	const sseRef = React.useRef<EventSource | null>(null);
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

	React.useEffect(() => () => {
		// Unmount (leaving the canvas, panel close): the run itself keeps going
		// server-side; the stream is simply detached. A remount re-discovers it.
		if (sseRef.current !== null) { sseRef.current.close(); sseRef.current = null; }
	}, []);

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

	// ---- Durable run lifecycle ----------------------------------------------
	// An active run is anything the Host reports as running or paused; the
	// canvas shows its per-node states, the Abort button, and (while a run is
	// active) an "editing affects the next run" hint. The immutable snapshot
	// was taken at POST time — canvas edits never touch the in-flight run.

	const runActive = activeRun !== null && (activeRun.state === "running" || activeRun.state === "paused");
	// The record is a firing log; the per-node view is computed, never stored.
	// pausedAt points at a FIRING; the projection resolves it to its node.
	const runProjection = runActive && activeRun !== null ? projectNodes(activeRun) : null;
	const pausedNodeId = runActive && activeRun?.state === "paused" ? runProjection?.pausedNodeId ?? null : null;
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
		setRunResult(recordToResult(rec));
		setResultOpen(true);
	}

	// Terminal record → the result modal's shape: the contract outputs keyed by
	// terminal id (only agents that produced an output) plus per-agent statuses,
	// all through the projection (the record itself is a firing log). The rows
	// walk the snapshot's topological order so never-started agents still list
	// as "pending" — the projection only knows nodes that fired.
	function recordToResult(rec: RunRecordLike): RunResultLike {
		const projection = projectNodes(rec);
		const runs = topoOrder(rec.graph).map((id) => {
			const node = projection.nodes[id];
			return {
				id,
				label: nameOf(id),
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
			.then((runId) => { connectRunEvents(runId); })
			.catch((err: unknown) => {
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
	// itself continues server-side.
	function openTranscript(childSessionId: string) {
		const sessions = services && services.sessions;
		if (sessions && typeof sessions.open === "function") sessions.open(childSessionId);
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

	// Load the saved graph once the workspace root is known. The response's
	// `run` field re-discovers an active run after a page reload (the SSE
	// stream is re-attached; a paused run's inspection modal reopens).
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
				setAgents(as.map((a: unknown) => {
					const loaded = loadAgent(a);
					const r = (a ?? {}) as { id?: unknown; name?: unknown; description?: unknown; instructions?: unknown; x?: unknown; y?: unknown; breakpoint?: unknown };
					return {
						id: String(r.id), name: String(r.name), description: String(r.description || ""),
						...(loaded.systemPrompt.length > 0 ? { systemPrompt: loaded.systemPrompt } : {}),
						instructions: String(r.instructions || ""),
						x: Number(r.x) || 0, y: Number(r.y) || 0,
						...(loaded.inputPorts !== undefined ? { inputPorts: loaded.inputPorts } : {}),
						...(loaded.outputPorts !== undefined ? { outputPorts: loaded.outputPorts } : {}),
						settings: loaded.settings,
						...(r.breakpoint === true ? { breakpoint: true } : {}),
					};
				}));
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
				// Discovery: adopt the workspace's active run (if any) and follow it.
				const active = data && data.ok === true && data.run !== null && typeof data.run === "object" ? data.run as RunRecordLike : null;
				if (active !== null && (active.state === "running" || active.state === "paused") && typeof active.runId === "string") {
					setActiveRun(active);
					connectRunEvents(active.runId);
				}
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
	function edgePath(s: { x: number; y: number }, t: { x: number; y: number }): string {
		return "M" + s.x + " " + s.y + " C" + (s.x + 60) + " " + s.y + " " + (t.x - 60) + " " + t.y + " " + t.x + " " + t.y;
	}
	const edges = connections.map((c) => {
		let src: CanvasAgent | null = null, tgt: CanvasAgent | null = null;
		for (let i = 0; i < agents.length; i++) {
			if (agents[i].id === c.source) src = agents[i];
			if (agents[i].id === c.target) tgt = agents[i];
		}
		if (!src || !tgt) return null;
		return <path key={c.id} d={edgePath(outPoint(src), inPoint(tgt))} className="pipeline-edge" markerEnd="url(#pipeline-arrow)" />;
	});
	let tempEdge: React.ReactNode = null;
	if (gesture) {
		let src0: CanvasAgent | null = null;
		for (let j = 0; j < agents.length; j++) if (agents[j].id === gesture.from) src0 = agents[j];
		if (src0) {
			const s0 = outPoint(src0);
			const cx = gesture.cursor ? gesture.cursor.x : s0.x;
			const cy = gesture.cursor ? gesture.cursor.y : s0.y;
			tempEdge = <path d={edgePath(s0, { x: cx, y: cy })} className="pipeline-edge-temp" />;
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
				<div
					className={"pipeline-port in" + (hoveredIn ? " hover" : "")}
					onPointerEnter={(e) => { onInputPointerEnter(e, agent); }}
					onPointerLeave={(e) => { onInputPointerLeave(e, agent); }}
					onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
					title="Input"
				/>
				<div
					className="pipeline-port out"
					onPointerDown={(e) => { onOutputPointerDown(e, agent); }}
					title="Output"
				/>
			</div>
		);
	});

	const graphData = buildGraph(agents, connections);
	const validation: ValidationResult = validateGraph(graphData);
	const warnCount = validation.warnings?.length ?? 0;
	const jsonText = JSON.stringify(graphData, null, 2);

	let configAgent: CanvasAgent | null = null;
	for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];

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
					<span className="pipeline-run-live" title="A run is active in this workspace — canvas edits affect the NEXT run only">
						{activeRun?.state === "paused" ? "Paused at " + nameOf(pausedNodeId as string) : "Running…"}
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
									...(updated.breakpoint === true ? { breakpoint: true } : { breakpoint: undefined }),
								}
								: a
						));
						setConfigAgentId(null);
					}}
					onClose={() => { setConfigAgentId(null); }}
				/>
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
		</div>
	);
}

export { PipelineView };
