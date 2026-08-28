// The Pipelines canvas view: the whole node workspace — a palette with a
// draggable Agent, a canvas, node move/select, the node edit button,
// output→input connections with directed edges, the toolbar (add/delete/
// JSON/clear/run/stop), load/save through the Host routes, and the run/result
// modals. Renders inside the per-session view tab AND the frame-wide shell
// panel (see ./shell-panel.tsx); the two hosts differ only in the props below.
import * as React from "react";
import { validateGraph } from "../graph.ts";
import { composePipelineInput, finalOutputText } from "../message.ts";
import type { ValidationResult } from "../types.ts";
import { AgentConfigPanel } from "./agent-config.tsx";
import { RunModal } from "./run-modal.tsx";
import { ResultModal } from "./result-modal.tsx";
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
	const [running, setRunning] = React.useState(false);
	const [runResult, setRunResult] = React.useState<RunResultLike | null>(null);
	const [resultOpen, setResultOpen] = React.useState(false);
	const [continueBusy, setContinueBusy] = React.useState<string | null>(null);
	const [continueStatus, setContinueStatus] = React.useState<string | null>(null);
	const runTextRef = React.useRef("");
	const runFilesRef = React.useRef<string[]>([]);
	/** The in-flight run's fetch AbortController; Stop aborts it (runAbortRef). */
	const runAbortRef = React.useRef<AbortController | null>(null);
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
	// The fetch rides a per-run AbortController: Stop aborts it, the browser
	// closes the connection, and the Host aborts the run server-side.
	function run(text: string, files: string[]) {
		if (running) return;
		runTextRef.current = text;
		runFilesRef.current = files;
		const g = buildGraph(agents, connections);
		const controller = new AbortController();
		runAbortRef.current = controller;
		setRunning(true);
		setRunResult(null);
		setShowRunModal(false);
		fetch(ENDPOINT + "/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, graph: g, input: composePipelineInput(text, files) }),
			signal: controller.signal,
		})
			.then((r) => {
				return r.text().then((body) => {
					let data: RunResultLike | null = null;
					try { data = body.length > 0 ? JSON.parse(body) : null; } catch { data = null; }
					if (!r.ok) return { ok: false, error: (data && data.error) ? data.error : ("HTTP " + r.status) };
					return data || { ok: false, error: "empty response" };
				});
			})
			.then((data) => { runAbortRef.current = null; setRunning(false); setRunResult(data); setResultOpen(true); })
			.catch((err: unknown) => {
				runAbortRef.current = null;
				setRunning(false);
				const stopped = (err as { name?: string } | null) !== null && (err as { name?: string }).name === "AbortError";
				setRunResult({ ok: false, error: stopped ? "Run stopped — the in-flight agent was interrupted." : String(err) });
				setResultOpen(true);
			});
	}

	// Stop the in-flight run: aborting the fetch closes the connection, which
	// the Host's run route watches — it aborts the pipeline server-side (the
	// in-flight agent is interrupted, later agents never start).
	function stopRun() {
		const controller = runAbortRef.current;
		if (controller) controller.abort();
	}

	// Open one agent's durable child session (the run's transcript). Navigating
	// to another session unmounts this view and drops the run result — that is
	// the accepted cost of every route that leaves the canvas.
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
				setAgents(as.map((a: unknown) => {
					const loaded = loadAgent(a);
					const r = (a ?? {}) as { id?: unknown; name?: unknown; description?: unknown; instructions?: unknown; x?: unknown; y?: unknown };
					return {
						id: String(r.id), name: String(r.name), description: String(r.description || ""),
						...(loaded.systemPrompt.length > 0 ? { systemPrompt: loaded.systemPrompt } : {}),
						instructions: String(r.instructions || ""),
						x: Number(r.x) || 0, y: Number(r.y) || 0,
						settings: loaded.settings,
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
		return (
			<div
				key={agent.id}
				className={"pipeline-node" + (selected ? " selected" : "")}
				style={{ left: agent.x + "px", top: agent.y + "px" }}
				data-agent-id={agent.id}
				onPointerDown={(e) => { onNodePointerDown(e, agent); }}
				onPointerMove={onNodePointerMove}
				onPointerUp={onNodePointerUp}
			>
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
	const jsonText = JSON.stringify(graphData, null, 2);

	let configAgent: CanvasAgent | null = null;
	for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];

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
					className={"pipeline-validation" + (validation.ok ? " ok" : " err")}
					title={validation.ok ? "Graph is a valid DAG" : "Graph has validation issues (see the issue list below)"}
					role="status"
				>
					{validation.ok ? "Valid" : validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")}
				</span>
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
					disabled={running || !validation.ok}
					title={running ? "Running…" : "Open the run dialog"}
					onClick={() => { setShowRunModal(true); }}
				>{running ? "Running…" : "Run"}</button>
				{running ? (
					<button
						className="pipeline-btn pipeline-btn-stop"
						title="Stop the run — interrupts the in-flight agent and skips the rest"
						onClick={stopRun}
					>Stop</button>
				) : null}
			</div>
			{validation.ok ? null : (
				<div className="pipeline-issues">
					{validation.errors.map((err) => (
						<div key={err.code + ":" + err.message} className="pipeline-issue">{err.message}</div>
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
								? { ...a, name: updated.name, description: updated.description, systemPrompt: updated.systemPrompt, instructions: updated.instructions, settings: updated.settings }
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
					running={running}
					fileList={services && services.remote && services.remote.fileReferences ? queryFiles : null}
					onRun={run}
					onClose={() => { setShowRunModal(false); }}
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
