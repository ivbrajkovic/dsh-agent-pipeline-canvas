// The Pipelines canvas view: the whole node workspace — a palette with a
// draggable Agent and an If control, a canvas, node move/select, the
// breakpoint toggle, connections drafted between the four connection points
// every node presents (direction is read off the WIRE — the grabbed side
// becomes an output, the dropped side an input, and missing port declarations
// materialize at the commit via resolveWireDrop; retractOrphanPorts undoes
// them when the wire goes away; an If's branch ticks are the labeled sources
// and the branch — identity a drop cannot infer — is the one picker; the if
// takes one unnamed input and owns its feeding agent's whole emission surface;
// during a run the if's DERIVED idle/armed/fired/quiet state lights the
// diamond's border and its branch edges — the chosen branch's edge and
// arrowhead light success green, the unchosen branches dim dashed — and a
// hover tooltip names the decision), the toolbar
// (add/delete/JSON/clear/run/abort), load/save
// through the Host routes, the run/result modals, and the paused-run
// inspection modal. Renders inside the per-session view tab AND the
// frame-wide shell panel (see ./shell-panel.tsx); the two hosts differ only
// in the props below.
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
import { validateGraph, cycleNodeIds, loopControlIds, inputPortOnSide, outputPortOnSide, resolveWireDrop, retractOrphanPorts, type PortPatch, type WireDropVerdict } from "../graph.ts";
import { countThreshold, firedBranches, lowerControls } from "../controls.ts";
import { classifyGraph, topoOrder, COUNT_KEY } from "../execution.ts";
import { projectNodes, type ProjectedNode } from "../projection.ts";
import { composePipelineInput, finalOutputText } from "../message.ts";
import type { IfBranch, PortSide, RunFiringStatus, ValidationError, ValidationResult } from "../types.ts";
import { AgentConfigPanel } from "./agent-config.tsx";
import { ControlConfigPanel } from "./control-config.tsx";
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
	loadControls,
	numericSuffix,
	type CanvasAgent,
	type CanvasConnection,
	type CanvasControl,
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

/** One if control's DERIVED run state (see controlRunState): the decision
 * state the border and branch edges show plus the branch names the source's
 * firing chose. `iter` rides along only on a loop decision (docs/proposals/
 * loops.md L4): the count is the feeding agent's firing number and the
 * threshold the `$count >= M` row parsed off the branches (null when none). */
type ControlRunState = { state: "idle" | "armed" | "fired" | "quiet"; chosen: string[]; iter?: { count: number; threshold: number | null } };

/** The iteration chip's text: "iter 2", promoted to "iter 2/3" by a parsed threshold. */
function iterLabel(iter: { count: number; threshold: number | null }): string {
	return "iter " + iter.count + (iter.threshold !== null ? "/" + iter.threshold : "");
}

/** The iteration in words for the tooltips: "iteration 2", "iteration 2 of 3". */
function iterWords(iter: { count: number; threshold: number | null }): string {
	return "iteration " + iter.count + (iter.threshold !== null ? " of " + iter.threshold : "");
}

/** The if control's hover tooltip: names the decision and its branches — the
 * words no longer rendered as a node tag — plus the loop iteration when the
 * control sits on a cycle. */
function controlRunTitle(runState: ControlRunState): string {
	const iter = runState.iter !== undefined ? " — " + iterWords(runState.iter) : "";
	return runState.state === "fired"
		? "The decision fired — branch " + runState.chosen.join(", ") + iter
		: runState.state === "quiet"
			? "The feeding agent's result matched no branch — nothing downstream of the if ran" + iter
			: runState.state === "armed"
				? "No branch decision recorded — the feeding agent's last firing never reached emission" + iter
				: "The run has not reached this decision yet" + iter;
}

/** The statuses that render on an agent node — pending renders nothing
 * (nothing has happened yet). */
type LiveFiringStatus = Exclude<RunFiringStatus, "pending">;

/** The status badge's tooltip: the word the old hanging pill printed. */
const RUN_STATUS_TITLE: Record<LiveFiringStatus, string> = {
	running: "Running",
	paused: "Paused at a breakpoint",
	done: "Finished",
	aborted: "Aborted — the run was stopped before this agent finished",
	error: "Failed — open Result for the error",
};

/** The status badge's glyph, shape-coded so the state never rides color
 * alone (the check/pause/stop/cross marks; running is the bare pulsing dot —
 * the badge itself, no glyph). currentColor inline SVGs, the breakpoint
 * dot's idiom. */
function statusBadgeIcon(status: LiveFiringStatus): React.ReactNode {
	switch (status) {
		case "done":
			return (
				<svg width={9} height={9} viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4 13l5 5L20 7" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			);
		case "paused":
			return (
				<svg width={8} height={8} viewBox="0 0 24 24" aria-hidden="true">
					<rect x={5} y={4} width={5} height={16} rx={1.5} fill="currentColor" />
					<rect x={14} y={4} width={5} height={16} rx={1.5} fill="currentColor" />
				</svg>
			);
		case "aborted":
			return (
				<svg width={8} height={8} viewBox="0 0 24 24" aria-hidden="true">
					<rect x={5} y={5} width={14} height={14} rx={2} fill="currentColor" />
				</svg>
			);
		case "error":
			return (
				<svg width={8} height={8} viewBox="0 0 24 24" aria-hidden="true">
					<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" />
				</svg>
			);
		case "running":
			// The bare pulsing dot IS the badge — no glyph.
			return null;
	}
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
	// The control's diamond (the flowchart decision shape): its bounding box.
	// Ticks anchor on the four VERTICES — a single branch lands exactly on its
	// vertex (frac 1/2); branches sharing a side spread along that axis and
	// if-side-conflict tells the author to spread them.
	const CONTROL_W = 150;
	const CONTROL_H = 84;
	const [agents, setAgents] = React.useState<CanvasAgent[]>([]);
	const [connections, setConnections] = React.useState<CanvasConnection[]>([]);
	// The if controls: first-class canvas nodes (the honest graph — what the
	// canvas shows is what the file carries; the run path lowers them).
	const [controls, setControls] = React.useState<CanvasControl[]>([]);
	const [seq, setSeq] = React.useState(1);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	// The selected CONNECTION, when the selection is an edge — selection is a
	// node or an edge, never both (selectNode/selectEdge keep that invariant),
	// so the Delete key and the toolbar button always act on one thing.
	const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null);
	/** Select a node (agent or control) — or clear the selection with null. */
	function selectNode(id: string | null) {
		setSelectedId(id);
		setSelectedEdgeId(null);
	}
	/** Select a connection by id — or clear the selection with null. */
	function selectEdge(id: string | null) {
		setSelectedEdgeId(id);
		setSelectedId(null);
	}
	const [connectCursor, setConnectCursor] = React.useState<{ x: number; y: number } | null>(null);
	const [hoverTarget, setHoverTarget] = React.useState<string | null>(null);
	// The node under the pointer at rest: its ports reveal on hover (and on
	// selection) — at rest every border stays uninterrupted, wires land flush.
	const [hoverNodeId, setHoverNodeId] = React.useState<string | null>(null);
	const [showJson, setShowJson] = React.useState(false);
	const [configAgentId, setConfigAgentId] = React.useState<string | null>(null);
	const [configControlId, setConfigControlId] = React.useState<string | null>(null);
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
	// A connection drafted from a CONTROL source: the branch is the one thing a
	// drop cannot infer (branch identity is behavior, not direction), so the
	// picker overlay confirms it. Both endpoints' sides ride along — the target
	// port resolves/mints at confirm, exactly like a direct drop.
	const [edgeDraft, setEdgeDraft] = React.useState<{ id: string; source: string; target: string; sourceSide: PortSide; targetSide: PortSide; picked: string } | null>(null);
	// The owner handoff: an agent wired into an if while it still carries its
	// own emission config (output ports / bindings) — the if owns that surface,
	// so the dialog offers to move it into the branches or clear it. The edge
	// is added either way; cancelling leaves the conflict to validateGraph.
	// The grab rides along so "Not now" can land the edge on the tick the drag
	// actually took.
	const [ownerHandoff, setOwnerHandoff] = React.useState<{ conn: { id: string; source: string; target: string }; control: CanvasControl; grabbedSourcePort?: string } | null>(null);
	// The node context menu: which canvas node (agent or control) it opened on
	// and the viewport point (clientX/clientY) it opened at; null when closed.
	const [nodeMenu, setNodeMenu] = React.useState<NodeMenuTarget | null>(null);
	const runTextRef = React.useRef("");
	const runFilesRef = React.useRef<string[]>([]);
	/** The live SSE subscription for the active run's record. */
	const sseRef = React.useRef<EventSource | null>(null);
	const canvasRef = React.useRef<HTMLDivElement | null>(null);
	const idRef = React.useRef(0);
	const dragRef = React.useRef<{ id: string; kind: "agent" | "control"; startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
	const connectRef = React.useRef<{ from: string; cursor: { x: number; y: number }; hoverTarget: string | null; startPort?: string; startSide?: PortSide } | null>(null);
	// Persistence plumbing.
	const cwdRef = React.useRef<string | undefined>(undefined);
	// The session key rides beside cwdRef for the same reason: the save
	// effect's deps are the graph only, so both request scopes are read at
	// save time, not from a possibly stale closure.
	const sessionIdRef = React.useRef("");
	const loadedRef = React.useRef(false);
	const skipNextPersistRef = React.useRef(false);
	const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const stateRef = React.useRef<{ agents: CanvasAgent[]; connections: CanvasConnection[]; controls: CanvasControl[] }>({ agents: [], connections: [], controls: [] });

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

	// A menu whose target vanished (Delete key, toolbar Delete, the menu's own
	// delete row, Clear) has nothing left to act on — close it. Controls are
	// watched beside agents: a menu opened on a control must not survive that
	// control's deletion. Edge menus watch the connection list the same way.
	React.useEffect(() => {
		if (nodeMenu === null) return;
		if (nodeMenu.kind === "edge") {
			if (!connections.some((c) => c.id === nodeMenu.id)) setNodeMenu(null);
			return;
		}
		if (!agents.some((a) => a.id === nodeMenu.id) && !controls.some((k) => k.id === nodeMenu.id)) setNodeMenu(null);
	}, [agents, connections, controls, nodeMenu]);

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
		selectNode(agent.id);
		return agent;
	}
	// A fresh if starts with a single catch-all branch ("else") — a valid,
	// silent control the branch editor fills in: valued branches added above
	// the catch-all become the decision, wired one tick each.
	function addControl(x: number, y: number): CanvasControl {
		const control: CanvasControl = { id: newId("if"), kind: "if", branches: [{ name: "else", field: "" }], x, y };
		setControls((prev) => prev.concat([control]));
		selectNode(control.id);
		return control;
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
		// A side hosting BOTH directions splits its axis: inputs take the first
		// half, outputs the second — the four-point shape (one tick per
		// direction per edge) never draws the two ticks on top of each other.
		const otherOnSide = (kind === "in" ? outputPortNamesOf(a.id) : inputPortNamesOf(a.id))
			.filter((n) => (kind === "in" ? outputPortSide(a, n) : inputPortSide(a, n)) === side)
			.length;
		const t = otherOnSide > 0 ? (kind === "in" ? frac * 0.5 : 0.5 + frac * 0.5) : frac;
		if (side === "left") return { x: a.x, y: a.y + NODE_H * t, side };
		if (side === "right") return { x: a.x + NODE_W, y: a.y + NODE_H * t, side };
		if (side === "top") return { x: a.x + NODE_W * t, y: a.y, side };
		return { x: a.x + NODE_W * t, y: a.y + NODE_H, side };
	}
	// The midpoint anchor of a node edge — where an open point sits (the
	// direction-neutral affordance). Works for both node kinds.
	function sideMidAnchor(node: CanvasAgent | CanvasControl, side: Side): { x: number; y: number; side: Side } {
		const w = "branches" in node ? CONTROL_W : NODE_W;
		const h = "branches" in node ? CONTROL_H : NODE_H;
		if (side === "left") return { x: node.x, y: node.y + h / 2, side };
		if (side === "right") return { x: node.x + w, y: node.y + h / 2, side };
		if (side === "top") return { x: node.x + w / 2, y: node.y, side };
		return { x: node.x + w / 2, y: node.y + h, side };
	}
	// Where a MINTED tick will land, matching portAnchor's split-axis rule: the
	// edge midpoint on an empty edge, or the direction's half when the opposite
	// direction already occupies the edge — so the temp wire aims exactly where
	// the authored tick will appear. Agents only (a control's single input
	// always exists and it never mints outputs).
	function mintAnchorOf(node: CanvasAgent | CanvasControl, side: Side, kind: "in" | "out"): { x: number; y: number; side: Side } {
		const shared = "branches" in node
			? false
			: kind === "in" ? outputPortOnSide(node, side) !== null : inputPortOnSide(node, side) !== null;
		const frac = shared ? (kind === "in" ? 0.25 : 0.75) : 0.5;
		const w = "branches" in node ? CONTROL_W : NODE_W;
		const h = "branches" in node ? CONTROL_H : NODE_H;
		if (side === "left") return { x: node.x, y: node.y + h * frac, side };
		if (side === "right") return { x: node.x + w, y: node.y + h * frac, side };
		if (side === "top") return { x: node.x + w * frac, y: node.y, side };
		return { x: node.x + w * frac, y: node.y + h, side };
	}
	// Per-side port occupancy for the open points: an edge hosting no port of
	// either direction renders one direction-neutral open point. A control's
	// left vertex is structural (the single unnamed input); an agent's edges
	// are occupied only by the ports that resolve onto them.
	function openSidesOf(node: CanvasAgent | CanvasControl): Side[] {
		const used = new Set<Side>();
		if ("branches" in node) {
			used.add("left");
			for (const name of branchNamesOf(node)) used.add(branchSideOf(node, name));
		} else {
			for (const n of inputPortNamesOf(node.id)) used.add(inputPortSide(node, n));
			for (const n of outputPortNamesOf(node.id)) used.add(outputPortSide(node, n));
		}
		const all: Side[] = ["left", "right", "top", "bottom"];
		return all.filter((s) => !used.has(s));
	}

	// The control's port-anchor model over its diamond: one unnamed input tick
	// on the left vertex, one labeled tick per branch on its declared edge's
	// vertex (default right), same stacking fraction as agent ports when
	// branches share a side.
	function controlInputAnchor(k: CanvasControl): { x: number; y: number; side: Side } {
		return { x: k.x, y: k.y + CONTROL_H / 2, side: "left" };
	}
	function branchSideOf(k: CanvasControl, branch: string): Side {
		const spec = k.branches.find((b) => String(b.name ?? "") === branch);
		return asSide(spec?.side) ?? "right";
	}
	function branchAnchor(k: CanvasControl, branch: string): { x: number; y: number; side: Side } {
		const side = branchSideOf(k, branch);
		const names = branchNamesOf(k);
		const sameSide = names.filter((n) => branchSideOf(k, n) === side);
		const frac = (Math.max(0, sameSide.indexOf(branch)) + 1) / (sameSide.length + 1);
		if (side === "left") return { x: k.x, y: k.y + CONTROL_H * frac, side };
		if (side === "right") return { x: k.x + CONTROL_W, y: k.y + CONTROL_H * frac, side };
		if (side === "top") return { x: k.x + CONTROL_W * frac, y: k.y, side };
		return { x: k.x + CONTROL_W * frac, y: k.y + CONTROL_H, side };
	}

	// node drag (pointer capture on the node). Primary button only: a
	// right-button press must not drag the node — it opens the context menu.
	// Covers agents and controls alike.
	function onNodePointerDown(e: React.PointerEvent, id: string, x: number, y: number, kind: "agent" | "control") {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		if (canvasRef.current) canvasRef.current.focus();
		e.currentTarget.setPointerCapture(e.pointerId);
		selectNode(id);
		dragRef.current = { id, kind, startClientX: e.clientX, startClientY: e.clientY, startX: x, startY: y };
	}
	function onNodePointerMove(e: React.PointerEvent) {
		const d = dragRef.current;
		if (!d) return;
		const nx = d.startX + (e.clientX - d.startClientX);
		const ny = d.startY + (e.clientY - d.startClientY);
		if (d.kind === "control") setControls((prev) => prev.map((k) => (k.id === d.id ? { ...k, x: nx, y: ny } : k)));
		else setAgents((prev) => prev.map((a) => (a.id === d.id ? { ...a, x: nx, y: ny } : a)));
	}
	function onNodePointerUp() {
		dragRef.current = null;
	}

	// connect (primary button only — a right-button press must not draft a
	// connection; the event bubbles to the node's context menu). ANY revealed
	// tick or open point starts a draft: the grab only remembers WHERE the wire
	// leaves — a pinned output tick, or just the node edge — never a direction.
	// The drop decides in vs out: the source side becomes an output, the target
	// side an input, and resolveWireDrop authors whatever declaration the node
	// was missing (ports materialize from wiring). A control's branch ticks and
	// its open points draft the same way, the branch confirmed in the picker.
	function onPortPointerDown(e: React.PointerEvent, nodeId: string, grab: { port: string } | { side: Side }) {
		if (e.button !== 0) return;
		if (connectRef.current !== null) return; // a drag owns the pointer
		e.preventDefault(); e.stopPropagation();
		if (canvasRef.current) canvasRef.current.focus();
		const p = canvasPoint(e.clientX, e.clientY);
		connectRef.current = {
			from: nodeId,
			cursor: { x: p.x, y: p.y },
			hoverTarget: null,
			...("port" in grab ? { startPort: grab.port } : { startSide: grab.side }),
		};
		setConnectCursor({ x: p.x, y: p.y });
		selectNode(nodeId);
	}
	// Hover + drop targeting ride the NODE, not the ticks: at rest hovering a
	// node reveals its ports; during a wire drag every node other than the
	// source is a live drop target — the WHOLE node accepts the drop, not just
	// the 14px tick (ports are hidden at rest, so the generous target is what
	// keeps wiring easy). Enter/leave semantics keep this stable across the
	// node's children (ticks, badge, breakpoint button).
	function onNodePointerEnter(e: React.PointerEvent, nodeId: string) {
		setHoverNodeId(nodeId);
		const c = connectRef.current;
		if (c !== null && c.from !== nodeId) {
			c.hoverTarget = nodeId;
			setHoverTarget(nodeId);
		}
	}
	function onNodePointerLeave(e: React.PointerEvent, nodeId: string) {
		setHoverNodeId((prev) => (prev === nodeId ? null : prev));
		const c = connectRef.current;
		if (c !== null && c.hoverTarget === nodeId) {
			c.hoverTarget = null;
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
	// The one connection landing, shared by every path that adds an edge (the
	// direct drop, the branch picker's confirm, the owner handoff): applies the
	// port-declaration patches resolveWireDrop authored — minted ports and the
	// backward-edge assist's entry flip (docs/proposals/loops.md L3), which the
	// resolver folds in — in the SAME update as the edge (one commit, one
	// debounced persist). The patches are real visible graph edits (the agent
	// panel's ports editor, View JSON).
	function landConnection(conn: CanvasConnection, agentUpdates: Record<string, PortPatch>) {
		if (Object.keys(agentUpdates).length > 0) {
			setAgents((prev) => prev.map((a) => (agentUpdates[a.id] !== undefined ? { ...a, ...agentUpdates[a.id] } : a)));
		}
		setConnections((prev) => prev.concat([conn]));
	}
	// The landed edge's persisted ports from a verdict: default names stay
	// unwritten — buildGraph composes the same wire ids (the historical shape).
	function connFromVerdict(base: { id: string; source: string; target: string }, verdict: WireDropVerdict): CanvasConnection {
		return {
			...base,
			...(verdict.sourcePort !== undefined && verdict.sourcePort !== "out" ? { sourcePort: verdict.sourcePort } : {}),
			...(verdict.targetPort !== undefined && verdict.targetPort !== "in" ? { targetPort: verdict.targetPort } : {}),
		};
	}
	function onContainerPointerUp() {
		const c = connectRef.current;
		if (!c) return;
		const target = c.hoverTarget;
		if (target != null && target !== c.from) {
			const exists = connections.some((conn) => conn.source === c.from && conn.target === target);
			if (!exists) {
				const conn = { id: newId("conn"), source: c.from, target };
				// The drop POINT is the intended entry: the node edge nearest the
				// cursor takes the wire, and its living input port — or a minted
				// one — receives it.
				const drop = dropSnapFor(target, c.cursor);
				const graph = buildGraph(agents, connections, controls);
				const draft = {
					source: conn.source,
					target,
					sourceSide: c.startSide ?? "right",
					targetSide: drop?.side ?? "left",
					grabbedSourcePort: c.startPort,
				};
				const targetControl = controls.find((k) => k.id === target);
				if (controls.some((k) => k.id === c.from)) {
					// Control → agent: the branch is the one decision a drop cannot
					// infer (branch identity is behavior, not direction) — the picker
					// confirms it. The target side resolves/mints exactly like a
					// direct drop, at confirm.
					const fromControl = controls.find((k) => k.id === c.from);
					const branches = branchNamesOf(fromControl as CanvasControl);
					const picked = c.startPort !== undefined && branches.includes(c.startPort) ? c.startPort : (branches[0] ?? "");
					setEdgeDraft({ id: conn.id, source: conn.source, target, sourceSide: draft.sourceSide, targetSide: draft.targetSide, picked });
				} else if (
					targetControl !== undefined
					&& agents.some((a) => a.id === c.from && (a.outputPorts !== undefined || a.bindings !== undefined))
				) {
					// Agent → control: the if owns the source's whole emission
					// surface. An agent carrying its own output ports or bindings
					// gets the owner handoff (move them into the branches or clear
					// them); a clean agent wires straight in — its grabbed side
					// mints/uses an output like any other drop.
					setOwnerHandoff({ conn, control: targetControl, ...(c.startPort !== undefined ? { grabbedSourcePort: c.startPort } : {}) });
				} else {
					const verdict = resolveWireDrop(graph, draft);
					landConnection(connFromVerdict(conn, verdict), verdict.agentUpdates);
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
		setHoverNodeId(null);
	}
	function onCanvasPointerDown(e: React.PointerEvent) {
		if (canvasRef.current) canvasRef.current.focus();
		selectNode(null);
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
	// Remove one canvas node — agent or control — by id. The control cascade:
	// deleting an AGENT also deletes any control it feeds (a control never
	// outlives its source) together with that control's edges; deleting a
	// control removes just its own edges. Shared by the toolbar Delete, the
	// Delete/Backspace key, and the context menu's delete row. Surviving
	// endpoints of the removed wires get the same unwire retraction as
	// deleteEdge — including the agent side of a deleted control's branch
	// edges: the control owns no ports, but the agent it fed may carry a port
	// that edge minted.
	function deleteNode(nodeId: string) {
		const selectedConn = selectedEdgeId !== null ? connections.find((c) => c.id === selectedEdgeId) : undefined;
		if (controls.some((k) => k.id === nodeId)) {
			const kept = connections.filter((c) => c.source !== nodeId && c.target !== nodeId);
			const removed = connections.filter((c) => c.source === nodeId || c.target === nodeId);
			const retract = retractOrphanPorts(buildGraph(agents, kept, controls), removed);
			const updates = retract.agentUpdates;
			setControls((prev) => prev.filter((k) => k.id !== nodeId));
			if (Object.keys(updates).length > 0) {
				setAgents((prev) => prev.map((a) => (updates[a.id] !== undefined ? { ...a, ...updates[a.id] } : a)));
			}
			setConnections(kept);
			if (selectedConn !== undefined && removed.includes(selectedConn)) setSelectedEdgeId(null);
		} else {
			const dying = new Set(
				controls.filter((k) => connections.some((c) => c.source === nodeId && c.target === k.id)).map((k) => k.id),
			);
			const keptAgents = agents.filter((a) => a.id !== nodeId);
			const keptControls = controls.filter((k) => !dying.has(k.id));
			const removed = connections.filter((c) => c.source === nodeId || c.target === nodeId || dying.has(c.source) || dying.has(c.target));
			const kept = connections.filter((c) => !removed.includes(c));
			const retract = retractOrphanPorts(buildGraph(keptAgents, kept, keptControls), removed);
			const updates = retract.agentUpdates;
			setAgents(keptAgents.map((a) => (updates[a.id] !== undefined ? { ...a, ...updates[a.id] } : a)));
			setControls((prev) => prev.filter((k) => !dying.has(k.id)));
			setConnections(kept);
			if (selectedConn !== undefined && removed.includes(selectedConn)) setSelectedEdgeId(null);
		}
		if (selectedId === nodeId) setSelectedId(null);
	}
	// Remove one connection by id — the direct answer to "undo a wire"
	// (previously only deleting an agent removed its connections). Shared by
	// the toolbar Delete, the Delete/Backspace key, and the edge context menu.
	// The unwire retraction rides along: endpoint ports the wire leaves
	// wireless — and that carry no authored behavior — retract in the same
	// update (retractOrphanPorts), so the canvas never shows a declared port
	// the wiring has abandoned.
	function deleteEdge(connId: string) {
		const conn = connections.find((c) => c.id === connId);
		const kept = conn !== undefined ? connections.filter((c) => c.id !== connId) : connections;
		setConnections(kept);
		if (conn !== undefined) {
			const retract = retractOrphanPorts(buildGraph(agents, kept, controls), [conn]);
			if (Object.keys(retract.agentUpdates).length > 0) {
				setAgents((prev) => prev.map((a) => (retract.agentUpdates[a.id] !== undefined ? { ...a, ...retract.agentUpdates[a.id] } : a)));
			}
		}
		if (selectedEdgeId === connId) setSelectedEdgeId(null);
	}
	function deleteSelected() {
		if (selectedId) {
			deleteNode(selectedId);
			return;
		}
		if (selectedEdgeId) deleteEdge(selectedEdgeId);
	}
	function clearAll() {
		setAgents([]); setConnections([]); setControls([]); selectNode(null); setHoverTarget(null); setConnectCursor(null);
		dragRef.current = null; connectRef.current = null;
		setSeq(1); idRef.current = 0;
		setRunResult(null); setResultOpen(false); setShowRunModal(false); setDoneRun(null);
		setNodeMenu(null);
		runTextRef.current = ""; runFilesRef.current = [];
	}

	// ---- Node context menu ----------------------------------------------------
	// Right-click a node (agent or control): select it and open the harness
	// Menu at the pointer (native menu suppressed on nodes only — the canvas
	// background keeps it). Agent entries are the pinned shape, headed by Go to
	// transcript — enabled once the projection holds a child session for the
	// node (live, paused, and restored-last-run records all project one; a
	// never-fired node shows the row disabled, and disabled rows never
	// dispatch). A control never fires a child session, so its menu carries
	// only Edit branches and Delete control. A connection's menu (right-click
	// the wire) carries just Delete connection.
	function onNodeContextMenu(e: React.MouseEvent, nodeId: string) {
		e.preventDefault(); e.stopPropagation();
		selectNode(nodeId);
		// A connection gesture owns the pointer; it keeps its cancel path
		// (Escape) and the right-click opens nothing.
		if (connectRef.current) return;
		setNodeMenu({ kind: "node", id: nodeId, x: e.clientX, y: e.clientY });
	}
	function onEdgeContextMenu(e: React.MouseEvent, connId: string) {
		e.preventDefault(); e.stopPropagation();
		selectEdge(connId);
		if (connectRef.current) return;
		setNodeMenu({ kind: "edge", id: connId, x: e.clientX, y: e.clientY });
	}
	function nodeMenuEntries(node: CanvasAgent | CanvasControl): MenuEntry[] {
		if ("branches" in node) {
			return [
				{ id: "edit", label: "Edit branches" },
				{ type: "separator", id: "menu-sep-delete" },
				{ id: "delete", label: "Delete control", danger: true },
			];
		}
		const childSessionId = runProjection?.nodes[node.id]?.childSessionId;
		return [
			{ id: "transcript", label: "Go to transcript", disabled: typeof childSessionId !== "string" || childSessionId.length === 0 },
			{ type: "separator", id: "menu-sep-edit" },
			{ id: "edit", label: "Edit agent" },
			{ id: "breakpoint", label: node.breakpoint ? "Disarm breakpoint" : "Arm breakpoint" },
			{ type: "separator", id: "menu-sep-delete" },
			{ id: "delete", label: "Delete agent", danger: true },
		];
	}
	function runNodeMenuAction(id: string) {
		if (nodeMenu === null) return;
		if (nodeMenu.kind === "edge") {
			if (id === "delete") deleteEdge(nodeMenu.id);
			return;
		}
		const nodeId = nodeMenu.id;
		const menuIsControl = controls.some((k) => k.id === nodeId);
		if (id === "edit") {
			// Route by node kind: an agent opens its config panel, a control
			// its branch editor.
			if (menuIsControl) setConfigControlId(nodeId);
			else setConfigAgentId(nodeId);
		} else if (id === "breakpoint") {
			// Same toggle the node's breakpoint button performs.
			setAgents((prev) => prev.map((a) => (a.id === nodeId ? { ...a, breakpoint: !a.breakpoint } : a)));
		} else if (id === "delete") {
			// Same removal as deleteSelected — node, edges, and (for an agent)
			// the source cascade to any control it feeds.
			deleteNode(nodeId);
		} else if (id === "transcript") {
			// Re-read at dispatch — the projection may have moved since open.
			// The wrapper closes the menu before this runs.
			const childSessionId = runProjection?.nodes[nodeId]?.childSessionId;
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

	// ---- The if control's derived run state ----------------------------------
	// A control never fires and never appears in the record's firings, nodes,
	// or results — its run state is DERIVED from the feeding agent's firing:
	// the firing's `emittedTo` names the lowered output ports, which are the
	// branch names (firedBranches). The state rides the source's LATEST firing
	// — the projection's own rule — so a rerun re-arms the control until the
	// new firing emits, exactly as an agent's badge moves. quiet is the decided
	// empty selection (the source emitted on no branch); armed is anything
	// in flight or settled without reaching emission. Null when no run view
	// exists at all.
	//
	// The loop membership (docs/proposals/loops.md L4) is a GRAPH fact, so it
	// is computed once per graph edit rather than per render; the iteration
	// count itself stays a per-render derivation off the record's firings —
	// derived, never stored.
	const loopControls = React.useMemo(
		() => loopControlIds(buildGraph(agents, connections, controls)),
		[agents, connections, controls],
	);
	function controlRunState(control: CanvasControl): ControlRunState | null {
		if (runProjection === null) return null;
		const sourceId = connections.find((c) => c.target === control.id)?.source;
		const node = sourceId !== undefined ? runProjection.nodes[sourceId] : undefined;
		if (node === undefined || node.firings.length === 0) return { state: "idle", chosen: [] };
		const firing = node.firings[node.firings.length - 1];
		// On a loop the feeding agent's firing count IS the iteration number
		// (its feeder fires once per pass), promoted with the threshold a
		// `$count >= M` row declares. Only a firing that happened counts —
		// before the first one the diamond stays idle and shows nothing.
		const iter = loopControls.has(control.id)
			? { count: node.firings.length, threshold: countThreshold(control.branches) }
			: undefined;
		const withIter = iter !== undefined ? { iter } : {};
		if (!Array.isArray(firing.emittedTo)) return { state: "armed", chosen: [], ...withIter };
		const chosen = firedBranches(control.branches, firing.emittedTo);
		return chosen.length > 0
			? { state: "fired", chosen, ...withIter }
			: { state: "quiet", chosen: [], ...withIter };
	}

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
	// as "pending" — the projection only knows nodes that fired. The snapshot
	// is the HONEST graph (its control edges are not agent adjacency), so the
	// classification runs on the lowered form — the same rewrite the run path
	// applied — or every control source would misclassify as a terminal.
	// `list` overrides the current canvas agents for the label lookup — the
	// load path calls this before the parsed agents have landed in state.
	function recordToResult(rec: RunRecordLike, list?: CanvasAgent[]): RunResultLike {
		const nameIn = (id: string): string => {
			for (const a of list ?? agents) if (a.id === id) return a.name;
			return id;
		};
		const projection = projectNodes(rec);
		const lowered = lowerControls(rec.graph);
		const runs = topoOrder(lowered).map((id) => {
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
		const terminals = classifyGraph(lowered).terminals;
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
		const g = buildGraph(agents, connections, controls);
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
	// back to the single default port when undeclared. A control's output side
	// is its BRANCH list (never "out") — the resolvers answer for controls too,
	// so the edge picker and the geometry can treat every endpoint uniformly.

	/** The node's output port names — an agent's declared outputs, a control's branch names. */
	function outputPortNamesOf(id: string): string[] {
		const control = controls.find((k) => k.id === id);
		if (control !== undefined) return branchNamesOf(control);
		const a = agents.find((x) => x.id === id);
		return a && Array.isArray(a.outputPorts) && a.outputPorts.length > 0 ? a.outputPorts : ["out"];
	}
	/** The control's declared branch names, in evaluation order. */
	function branchNamesOf(control: CanvasControl): string[] {
		return control.branches.map((b) => String(b.name ?? "")).filter((n) => n.length > 0);
	}
	/** The node's input port names (declared, else the single "in"; a control takes one unnamed input). */
	function inputPortNamesOf(id: string): string[] {
		const a = agents.find((x) => x.id === id);
		return a && Array.isArray(a.inputPorts) && a.inputPorts.length > 0 ? a.inputPorts.map((p) => p.name) : ["in"];
	}
	/** The port NAME a persisted wire id carries ("<agentId>:<name>" → name). */
	function portNameOf(wire: unknown, agentId: string, fallback: string): string {
		const s = String(wire ?? "");
		return s.startsWith(agentId + ":") ? s.slice(agentId.length + 1) : fallback;
	}
	/** Complete a control-sourced draft: the picked branch pins the source; the
	 * target side resolves/mints exactly like a direct drop (one resolver, one
	 * commit — the same patches any other landing applies). */
	function confirmEdgeDraft() {
		const d = edgeDraft;
		if (!d) return;
		setEdgeDraft(null);
		const verdict = resolveWireDrop(buildGraph(agents, connections, controls), {
			source: d.source,
			target: d.target,
			sourceSide: d.sourceSide,
			targetSide: d.targetSide,
			grabbedSourcePort: d.picked,
		});
		landConnection(connFromVerdict({ id: d.id, source: d.source, target: d.target }, verdict), verdict.agentUpdates);
	}
	/** The picker's "to" line: what the landed side will receive. */
	function edgeDraftTargetText(): string {
		const d = edgeDraft;
		if (!d) return "";
		if (controls.some((k) => k.id === d.target)) return "the control's single unnamed input";
		const agent = agents.find((a) => a.id === d.target);
		const port = agent !== undefined ? inputPortOnSide(agent, d.targetSide) : null;
		return port !== null ? "input port " + port : "a new input port on the " + d.targetSide + " edge";
	}

	// The owner handoff's Move: the agent's emission config folds into branch
	// rules — the bindings first (they carry the decision, in evaluation
	// order), then any declared output port no binding covered. A ""/absent
	// binding value stays a catch-all; sides follow the port; a ">=" op
	// forwards (the counter row must survive the move — it may be the loop's
	// guard).
	function moveEmissionInto(source: CanvasAgent): IfBranch[] {
		const branches: IfBranch[] = [];
		const seen = new Set<string>();
		const sideFor = (port: string): PortSide | undefined => source.outputPortSides?.[port];
		for (const b of Array.isArray(source.bindings) ? source.bindings : []) {
			const port = typeof b?.port === "string" ? b.port : "";
			if (port.length === 0 || seen.has(port)) continue;
			seen.add(port);
			const side = sideFor(port);
			branches.push({
				name: port,
				field: typeof b?.field === "string" ? b.field : "",
				...(b?.value !== undefined && b.value !== "" ? { value: String(b.value) } : {}),
				...(b?.op === ">=" ? { op: ">=" } : {}),
				...(side !== undefined && side !== "right" ? { side } : {}),
			});
		}
		for (const port of Array.isArray(source.outputPorts) ? source.outputPorts : []) {
			if (typeof port !== "string" || port.length === 0 || seen.has(port)) continue;
			seen.add(port);
			const side = sideFor(port);
			branches.push({
				name: port,
				field: "",
				...(side !== undefined && side !== "right" ? { side } : {}),
			});
		}
		return branches;
	}
	// Moved branches join the control ahead of its trailing catch-all (which
	// stays last), skipping names the control already declares.
	function appendBranches(control: CanvasControl, moved: IfBranch[]): IfBranch[] {
		const names = new Set(control.branches.map((b) => String(b.name ?? "")));
		const fresh = moved.filter((b) => !names.has(b.name));
		if (fresh.length === 0) return control.branches;
		const last = control.branches[control.branches.length - 1];
		const cut = control.branches.length - (last !== undefined && (last.value === undefined || last.value === "") ? 1 : 0);
		return control.branches.slice(0, cut).concat(fresh, control.branches.slice(cut));
	}
	// Resolve the handoff: Move or Clear both strip the agent's emission
	// surface, so the edge lands on the default out — the only port left.
	// "Not now" keeps the agent's ports, so a grabbed output tick stays the
	// truthful anchor: the edge lands on it when it names a declared output
	// (never minting — the ownership conflict is already the strip's business).
	function resolveOwnerHandoff(mode: "move" | "clear" | "dismiss") {
		const handoff = ownerHandoff;
		if (handoff === null) return;
		setOwnerHandoff(null);
		if (mode !== "dismiss") {
			const strip = (a: CanvasAgent) => (
				a.id === handoff.conn.source ? { ...a, outputPorts: undefined, outputPortSides: undefined, bindings: undefined } : a
			);
			if (mode === "move") {
				const source = agents.find((a) => a.id === handoff.conn.source);
				if (source !== undefined) {
					const moved = moveEmissionInto(source);
					setControls((prev) => prev.map((k) => (k.id === handoff.control.id ? { ...k, branches: appendBranches(k, moved) } : k)));
				}
			}
			setAgents((prev) => prev.map(strip));
			landConnection(handoff.conn, {});
			return;
		}
		const source = agents.find((a) => a.id === handoff.conn.source);
		const declared = source !== undefined && Array.isArray(source.outputPorts)
			? source.outputPorts.filter((n): n is string => typeof n === "string" && n.length > 0)
			: [];
		const grabbed = handoff.grabbedSourcePort;
		const sourcePort = grabbed !== undefined && declared.includes(grabbed) ? grabbed : "out";
		landConnection({ ...handoff.conn, ...(sourcePort !== "out" ? { sourcePort } : {}) }, {});
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
		} else if (e.dataTransfer.getData("application/x-pipeline-control") === "if") {
			const p = canvasPoint(e.clientX, e.clientY);
			addControl(p.x - CONTROL_W / 2, p.y - CONTROL_H / 2);
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
	// fire time), a node menu anchored to ids the new graph may reuse, and
	// the selection — a selected wire must not survive into a graph whose
	// ids (conn-N is a per-session counter) may collide, or Delete would
	// remove the NEW session's connection.
	React.useEffect(() => {
		disconnectRunEvents();
		setActiveRun(null);
		setDoneRun(null);
		setRunResult(null);
		setResultOpen(false);
		setNodeMenu(null);
		selectNode(null);
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
				const ks = loadControls(p == null ? undefined : (p as { controls?: unknown }).controls);
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
				setControls(ks);
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
				// The shared counter also numbers the "if-N" id space — the load
				// re-seeds it from the controls, exactly mirroring the Clear reset.
				ks.forEach((k) => { const n = numericSuffix(k.id); if (n > maxId) maxId = n; });
				idRef.current = maxId;
				let maxSeq = 0;
				as.forEach((a: { name: unknown }) => {
					const m = /^Agent\s+(\d+)$/.exec(String(a.name));
					const v = m ? parseInt(m[1], 10) : 0;
					if (v > maxSeq) maxSeq = v;
				});
				setSeq(maxSeq + 1);
				// Discovery: adopt the session's active run (if any) and follow it.
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
		stateRef.current = { agents, connections, controls };
		if (!loadedRef.current) return;
		if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return; }
		if (!(typeof cwdRef.current === "string" && cwdRef.current.length > 0)) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			const g = buildGraph(stateRef.current.agents, stateRef.current.connections, stateRef.current.controls);
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
	}, [agents, connections, controls]);

	const gesture = connectRef.current;
	// What the in-flight draft is aimed at while the pointer hovers a valid
	// target: the node edge nearest the cursor (the drop POINT is the intended
	// entry) and the input port living on that edge — null when the landing
	// mints one. Drives the temp wire's landing point and the tick/open-point
	// ring, and it is the exact reading resolveWireDrop commits, so the preview
	// and the landed graph can never disagree.
	type DropAim = { side: Side; port: string | null };
	const aim: DropAim | null = gesture !== null && hoverTarget !== null ? dropSnapFor(hoverTarget, gesture.cursor) : null;
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
	// Wires land FLUSH on the border: ports are hidden at rest (they reveal on
	// node hover / during a drag), so the bare joint must read clean, and a
	// revealed tick paints above the edge layer over the junction anyway.
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
			const sx = Math.sign(t.x - s.x);
			const r = Math.min(BRACKET_R, Math.abs(t.x - s.x) / 2, Math.abs(lane - s.y), Math.abs(lane - t.y));
			let d: string;
			if (!Number.isFinite(r) || r < 1 || sx === 0) {
				// Nodes nearly aligned: sharp corners (or a straight drop).
				d = "M" + s.x + " " + s.y + " L" + s.x + " " + lane + " L" + t.x + " " + lane + " L" + t.x + " " + t.y;
			} else {
				d = "M" + s.x + " " + s.y
					+ " L" + s.x + " " + (lane - vdir * r)
					+ " Q" + s.x + " " + lane + " " + (s.x + sx * r) + " " + lane
					+ " L" + (t.x - sx * r) + " " + lane
					+ " Q" + t.x + " " + lane + " " + t.x + " " + (lane - vdir * r)
					+ " L" + t.x + " " + t.y;
			}
			// Label rides the bracket's horizontal run (above it for a bottom
			// lane, below it for a top lane).
			return { d, mx: (s.x + t.x) / 2, my: down ? lane - 8 : lane + 14 };
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
		// Arrive at the anchor: the wire lands flush on the border (a revealed
		// tick paints over the junction; hidden, the joint reads clean).
		const d = "M" + s.x + " " + s.y + " C" + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + t.x + " " + t.y;
		// Exact cubic midpoint of the full curve — the label rides the curve,
		// offset along the curve's NORMAL at that point so it sits beside the
		// wire instead of crossing it (a bare vertical shift still crosses on
		// steep or S-curving wires). The normal is flipped to one consistent
		// side: above the wire where it runs horizontal, to its left when
		// vertical.
		const mx = (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8;
		const my = (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8;
		const tgx = t.x + c2.x - c1.x - s.x;
		const tgy = t.y + c2.y - c1.y - s.y;
		const tgLen = Math.hypot(tgx, tgy);
		let nx = tgLen > 0 ? -tgy / tgLen : 0;
		let ny = tgLen > 0 ? tgx / tgLen : -1;
		if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
		return { d, mx: mx + nx * 11, my: my + ny * 11 };
	}
	// Endpoint resolution spans both node kinds: an agent anchors through its
	// port model, a control through the branch ticks (source) and the single
	// unnamed input (target).
	function findNode(id: string): CanvasAgent | CanvasControl | null {
		for (const a of agents) if (a.id === id) return a;
		for (const k of controls) if (k.id === id) return k;
		return null;
	}
	function outputAnchorOf(node: CanvasAgent | CanvasControl, port: string): { x: number; y: number; side: Side } {
		return "branches" in node ? branchAnchor(node, port) : portAnchor(node, "out", port);
	}
	function inputAnchorOf(node: CanvasAgent | CanvasControl, port: string): { x: number; y: number; side: Side } {
		return "branches" in node ? controlInputAnchor(node) : portAnchor(node, "in", port);
	}
	// The snap: the node edge nearest `pt` (relative to the box center) and the
	// input port already living on it — null when the edge is open and the drop
	// will mint one. A control answers its single unnamed input on the left
	// vertex. Pure geometry plus the shared inputPortOnSide reading.
	function dropSnapFor(nodeId: string, pt: { x: number; y: number } | null): DropAim | null {
		const node = findNode(nodeId);
		if (node === null || pt === null) return null;
		if ("branches" in node) return { side: "left", port: "in" };
		const dx = pt.x - (node.x + NODE_W / 2);
		const dy = pt.y - (node.y + NODE_H / 2);
		const side: Side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
		return { side, port: inputPortOnSide(node, side) };
	}
	const edges = connections.map((c) => {
		const src = findNode(c.source);
		const tgt = findNode(c.target);
		if (!src || !tgt) return null;
		const sourceName = c.sourcePort ?? "out";
		const targetName = c.targetPort ?? "in";
		const s = outputAnchorOf(src, sourceName);
		const t = inputAnchorOf(tgt, targetName);
		// A non-default port name is labeled at the edge midpoint — the canvas
		// shows the real dataflow (design principle 2). A quiet port (its
		// binding simply never matched) needs no extra rendering: an edge is
		// only labeled wiring, never a promise the message arrived. A
		// control-sourced edge stays unlabeled: its branch name already rides
		// the branch tick at the decision point, and an edge label would
		// repeat it verbatim.
		const labeled = !("branches" in src) && (sourceName !== "out" || targetName !== "in");
		// Branch-edge highlighting (the run view): once the control's decision
		// has landed (fired or quiet), the chosen branch's edge — and its
		// arrowhead (the -fired marker) — light success green and the branches
		// that stayed unchosen dim to dashed gray; idle/armed decisions leave
		// every edge at its default (no promise yet).
		const controlState = "branches" in src ? controlRunState(src) : null;
		const edgeState = controlState !== null && (controlState.state === "fired" || controlState.state === "quiet")
			? (controlState.chosen.indexOf(sourceName) !== -1 ? "fired" : "quiet")
			: "";
		const geo = edgeGeometry(s, t);
		// Selection (brand stroke + arrow) wins over the run-state styling —
		// it is the transient "you are pointing at this wire" emphasis.
		const selected = selectedEdgeId === c.id;
		return (
			<g key={c.id} className="pipeline-edge-group">
				<path
					d={geo.d}
					className={"pipeline-edge" + (edgeState !== "" ? " pipeline-edge-" + edgeState : "") + (selected ? " pipeline-edge-selected" : "")}
					markerEnd={selected ? "url(#pipeline-arrow-selected)" : edgeState === "fired" ? "url(#pipeline-arrow-fired)" : "url(#pipeline-arrow)"}
				/>
				{labeled ? (
					<text x={geo.mx} y={geo.my} className="pipeline-edge-label" textAnchor="middle">
						{sourceName + " → " + targetName}
					</text>
				) : null}
				{/* The hit path: a 2px wire is unclickable, so a transparent
				    12px stroke above it carries selection (click) and the
				    menu (right-click); its hover lights the visible wire via
				    the group's :hover. A press during a wire drag is swallowed
				    (not the canvas's cancel), and a right-button press bubbles
				    to the canvas like a node's. */}
				<path
					d={geo.d}
					className="pipeline-edge-hit"
					onPointerDown={(e) => {
						if (e.button !== 0) return;
						e.preventDefault(); e.stopPropagation();
						if (canvasRef.current) canvasRef.current.focus();
						if (!connectRef.current) selectEdge(c.id);
					}}
					onContextMenu={(e) => { onEdgeContextMenu(e, c.id); }}
				/>
			</g>
		);
	});
	let tempEdge: React.ReactNode = null;
	if (gesture) {
		const src0 = findNode(gesture.from);
		if (src0) {
			// The draft's tail: the pinned output tick when the grab took one,
			// else the anchor the minted tick will occupy on the grabbed edge.
			const s0 = gesture.startPort !== undefined
				? outputAnchorOf(src0, gesture.startPort)
				: "branches" in src0
					? sideMidAnchor(src0, gesture.startSide ?? "right")
					: mintAnchorOf(src0, gesture.startSide ?? "right", "out");
			// Snap: over a target the wire lands on the aimed edge — its living
			// input port's anchor, or the minted tick's predicted anchor. Free
			// space keeps it on the cursor.
			let end0: { x: number; y: number; side: Side } = { x: gesture.cursor.x, y: gesture.cursor.y, side: "left" };
			if (aim !== null && hoverTarget !== null) {
				const tgt0 = findNode(hoverTarget);
				if (tgt0 !== null) end0 = aim.port !== null ? inputAnchorOf(tgt0, aim.port) : mintAnchorOf(tgt0, aim.side, "in");
			}
			tempEdge = <path d={edgeGeometry(s0, end0).d} className="pipeline-edge-temp" />;
		}
	}

	const nodes = agents.map((agent) => {
		const selected = agent.id === selectedId;
		const hoveredIn = hoverTarget === agent.id && gesture;
		const nodeState = runProjection !== null ? runProjection.nodes[agent.id] : undefined;
		const status = nodeState?.status;
		// Everything but pending renders: the node-state class (border + tint)
		// and the corner badge.
		const liveStatus = status !== undefined && status !== "pending" ? status : null;
		// Port reveal: at rest a node shows its ticks and open points on hover
		// or selection; during a wire drag the source keeps everything and EVERY
		// other node shows its input ticks and open points — you can see where
		// you can land (the snap ring and the aim stay on the node under the
		// pointer). Otherwise none — the border stays uninterrupted and wires
		// land flush on it.
		const reveal = gesture !== null
			? (gesture.from === agent.id ? " reveal-full" : " reveal-in")
			: (hoverNodeId === agent.id || selected ? " reveal-full" : "");
		return (
			<div
				key={agent.id}
				className={"pipeline-node" + (selected ? " selected" : "") + (liveStatus !== null ? " node-" + liveStatus : "") + reveal}
				style={{ left: agent.x + "px", top: agent.y + "px" }}
				data-agent-id={agent.id}
				data-node-status={status ?? ""}
				onPointerDown={(e) => { onNodePointerDown(e, agent.id, agent.x, agent.y, "agent"); }}
				onPointerEnter={(e) => { onNodePointerEnter(e, agent.id); }}
				onPointerLeave={(e) => { onNodePointerLeave(e, agent.id); }}
				onPointerMove={onNodePointerMove}
				onPointerUp={onNodePointerUp}
				onContextMenu={(e) => { onNodeContextMenu(e, agent.id); }}
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
				<div className="node-name">{agent.name}</div>
				<div className="node-sub">{agent.id}</div>
				{liveStatus !== null ? (
					<div className={"node-badge status-" + liveStatus} title={RUN_STATUS_TITLE[liveStatus]} aria-label={agent.name + ": " + RUN_STATUS_TITLE[liveStatus]}>
						{statusBadgeIcon(liveStatus)}
					</div>
				) : null}
				{inputPortNamesOf(agent.id).map((portName) => {
					const anchor = portAnchor(agent, "in", portName);
					const multiple = inputPortNamesOf(agent.id).length > 1 || anchor.side !== "left";
					return (
						<div
							key={portName}
							className={"pipeline-port in" + (hoveredIn && aim !== null && aim.port === portName ? " hover" : "")}
							style={{ left: (anchor.x - agent.x) + "px", top: (anchor.y - agent.y) + "px" }}
							// The tick starts a wire draft like any other point —
							// direction is the WIRE's, never the tick's: dragging
							// away from an input edge makes that edge an output.
							// Hover/drop targeting lives on the node itself, and a
							// right-button press bubbles to the node's menu.
							onPointerDown={(e) => { onPortPointerDown(e, agent.id, { side: anchor.side }); }}
							title={multiple ? portName + " — drag from this edge to make it an output" : "Input — drag from this edge to make it an output"}
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
							onPointerDown={(e) => { onPortPointerDown(e, agent.id, { port: portName }); }}
							title={multiple ? portName : "Output"}
						/>
					);
				})}
				{openSidesOf(agent).map((side) => {
					const anchor = sideMidAnchor(agent, side);
					return (
						<div
							key={"open-" + side}
							className={"pipeline-port ghost" + (hoveredIn && aim !== null && aim.port === null && aim.side === side ? " hover" : "")}
							style={{ left: (anchor.x - agent.x) + "px", top: (anchor.y - agent.y) + "px" }}
							onPointerDown={(e) => { onPortPointerDown(e, agent.id, { side }); }}
							title={"Open " + side + " point — drag from it to make it an output, drop a wire on it to make it an input"}
						/>
					);
				})}
			</div>
		);
	});

	const graphData = buildGraph(agents, connections, controls);
	const validation: ValidationResult = validateGraph(graphData);
	const warnCount = validation.warnings?.length ?? 0;
	const jsonText = JSON.stringify(graphData, null, 2);

	// validateGraph's warnings that name this control (a never-fire source, a
	// side stack) — surfaced on the node's warning chip and in the branch
	// editor; the rule messages name the control in quotes.
	function controlWarnings(control: CanvasControl): ValidationError[] {
		return (validation.warnings ?? []).filter((w) => w.message.indexOf('"' + control.id + '"') !== -1);
	}

	// The branch editor's per-row shadowing diagnosis (docs/proposals/loops.md
	// L3): for each VALUED $count row, the first row above it whose branch
	// wiring enters a cycle node — the arrangement that makes the count row no
	// guard, worded like cycle-unguarded's row finding. Computed here, where
	// the graph lives (the editor sees only its draft rows); keyed by branch
	// name so the editor's local reordering keeps each warning on its row.
	function branchShadowWarnings(control: CanvasControl): Record<string, string> {
		const onCycle = cycleNodeIds(graphData);
		const out: Record<string, string> = {};
		control.branches.forEach((row, index) => {
			if (row.field !== COUNT_KEY) return;
			if (row.value === undefined || row.value === "") return;
			const rowName = String(row.name ?? "");
			for (let above = 0; above < index; above++) {
				const name = String(control.branches[above].name ?? "");
				if (name.length === 0) continue;
				const wiresIntoLoop = connections.some((c) => c.source === control.id && c.sourcePort === name && onCycle.has(c.target));
				if (wiresIntoLoop) {
					out[rowName] = `the $count row "${rowName}" sits below row "${name}", which wires back into the loop and shadows it`;
					break;
				}
			}
		});
		return out;
	}

	// The control nodes: the flowchart DECISION shape — a diamond — one
	// unnamed input tick on the left vertex, one labeled tick per branch on
	// its declared edge's vertex (stacking when branches share a side) — the
	// fork is visible without opening any panel. The shape itself is an SVG
	// layer (not a clip-path on the node box) so the border follows the
	// diamond. No breakpoint button: a control never fires a child session
	// (the projection knows agents only). Its run state is DERIVED (idle/
	// armed/fired/quiet from the feeding agent's firing) and shows as the
	// diamond's BORDER — armed brand, fired success, quiet warning; idle
	// stays at rest — plus the branch-edge highlight and the hover tooltip;
	// no run word is rendered. Editing is the context menu's Edit branches —
	// nodes carry no edit button.
	const controlNodes = controls.map((control) => {
		const selected = control.id === selectedId;
		const hoveredIn = hoverTarget === control.id && gesture;
		const isIf = control.kind === "if";
		const warnings = controlWarnings(control);
		const runState = controlRunState(control);
		const lit = runState !== null && runState.state !== "idle" ? " control-" + runState.state : "";
		// Port reveal, same rule as the agents: the input tick, the branch
		// dots, and the open points show on hover/selection, and during a wire
		// drag every control but the source shows its input tick and open
		// points. The branch NAME labels stay visible always — they carry the
		// fork's semantics, not the affordance.
		const reveal = gesture !== null
			? (gesture.from === control.id ? " reveal-full" : " reveal-in")
			: (hoverNodeId === control.id || selected ? " reveal-full" : "");
		return (
			<div
				key={control.id}
				className={"pipeline-node control" + (selected ? " selected" : "") + lit + reveal}
				style={{ left: control.x + "px", top: control.y + "px" }}
				data-control-id={control.id}
				data-control-run-state={runState?.state ?? ""}
				title={runState !== null ? controlRunTitle(runState) : undefined}
				onPointerDown={(e) => { onNodePointerDown(e, control.id, control.x, control.y, "control"); }}
				onPointerEnter={(e) => { onNodePointerEnter(e, control.id); }}
				onPointerLeave={(e) => { onNodePointerLeave(e, control.id); }}
				onPointerMove={onNodePointerMove}
				onPointerUp={onNodePointerUp}
				onContextMenu={(e) => { onNodeContextMenu(e, control.id); }}
			>
				<svg className="control-shape" viewBox={"0 0 " + CONTROL_W + " " + CONTROL_H} preserveAspectRatio="none" aria-hidden="true">
					<polygon points={CONTROL_W / 2 + ",0 " + CONTROL_W + "," + CONTROL_H / 2 + " " + CONTROL_W / 2 + "," + CONTROL_H + " 0," + CONTROL_H / 2} />
				</svg>
				<div className="node-name">{isIf ? "if" : control.kind}</div>
				<div className="node-sub">{control.id}</div>
				{warnings.length > 0 ? (
					<div className="node-warn" title={warnings.map((w) => w.message).join("\n")}>
						{"⚠ " + warnings.length}
					</div>
				) : null}
				{runState?.iter !== undefined ? (
					<div
						className="node-iter"
						title={iterWords(runState.iter) + " — the feeding agent's firing count on this loop"}
					>
						{iterLabel(runState.iter)}
					</div>
				) : null}
				<div
					className={"pipeline-port in" + (hoveredIn && aim !== null && aim.port === "in" ? " hover" : "")}
					style={{ left: "0px", top: (CONTROL_H / 2) + "px" }}
					// The input tick starts a wire draft like any point (the
					// branch picker resolves the control's output side); a
					// right-button press bubbles to the node and opens the menu.
					onPointerDown={(e) => { onPortPointerDown(e, control.id, { side: "left" }); }}
					title="Input — drag from this control to branch from it"
				/>
				{isIf ? branchNamesOf(control).map((branchName, index) => {
					const anchor = branchAnchor(control, branchName);
					return (
						<div
							key={branchName + ":" + index}
							className={"control-branch side-" + anchor.side}
							style={{ left: (anchor.x - control.x) + "px", top: (anchor.y - control.y) + "px" }}
						>
							<div
								className="pipeline-port out"
								onPointerDown={(e) => { onPortPointerDown(e, control.id, { port: branchName }); }}
								title={"Branch " + branchName + " — drag to the agent that handles it"}
							/>
							<span className="branch-label">{branchName}</span>
						</div>
					);
				}) : null}
				{openSidesOf(control).map((side) => {
					const anchor = sideMidAnchor(control, side);
					return (
						<div
							key={"open-" + side}
							className={"pipeline-port ghost" + (hoveredIn && aim !== null && aim.port === null && aim.side === side ? " hover" : "")}
							style={{ left: (anchor.x - control.x) + "px", top: (anchor.y - control.y) + "px" }}
							onPointerDown={(e) => { onPortPointerDown(e, control.id, { side }); }}
							title={"Open " + side + " point — drag from it to branch from this control"}
						/>
					);
				})}
			</div>
		);
	});

	let configAgent: CanvasAgent | null = null;
	for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];
	let configControl: CanvasControl | null = null;
	for (let k = 0; k < controls.length; k++) if (controls[k].id === configControlId) configControl = controls[k];

	// The context menu's entries re-compute per its node, so the breakpoint
	// label always reflects the live state; while the node is mid-vanish
	// (before the close effect lands) the list simply renders empty.
	const menuNode: CanvasAgent | CanvasControl | null = nodeMenu !== null && nodeMenu.kind === "node" ? findNode(nodeMenu.id) : null;
	// The context menu's entries re-compute per its target: per-node rows for
	// agents/controls, the single delete row for a connection. While the
	// target is mid-vanish (before the close effect lands) the list renders
	// empty.
	const menuEntries: readonly MenuEntry[] = nodeMenu !== null && nodeMenu.kind === "edge"
		? [{ id: "delete", label: "Delete connection", danger: true }]
		: menuNode !== null ? nodeMenuEntries(menuNode) : [];

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
				<span className="stat">{agents.length + " agents" + (controls.length > 0 ? " · " + controls.length + (controls.length === 1 ? " control" : " controls") : "") + " · " + connections.length + " connections"}</span>
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
							: "A run is active in this session — canvas edits affect the NEXT run only"}
					>
						{failedNodeId !== null
							? "Failed at " + nameOf(failedNodeId) + " — finishing in-flight agents…"
							: activeRun?.state === "paused"
								? "Paused at " + nameOf(pausedNodeId as string) + (queuedCount > 0 ? " +" + queuedCount + " queued" : "")
								: "Running…"}
					</span>
				) : null}
				<button className="pipeline-btn" onClick={addAgentFromToolbar}>+ Add Agent</button>
				<button
					className="pipeline-btn"
					onClick={deleteSelected}
					disabled={!selectedId && !selectedEdgeId}
					title={selectedEdgeId && !selectedId ? "Delete the selected connection" : "Delete the selected node"}
				>Delete</button>
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
					title={runActive ? "A run is already active in this session" : startPending ? "Starting the run…" : "Open the run dialog"}
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
					<div
						className="palette-item"
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData("application/x-pipeline-control", "if");
							e.dataTransfer.effectAllowed = "copy";
						}}
					>
						<div className="palette-icon if" />
						If
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
							{/* The fired branch's arrowhead lights with its line — a
							    marker cannot inherit the path's stroke, so the fired
							    edge points at its own success-filled def. */}
							<marker id="pipeline-arrow-fired" markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto" markerUnits="strokeWidth">
								<path d="M0,0 L6,3 L0,6 Z" className="pipeline-arrowfill-fired" />
							</marker>
							{/* Same rule for selection: the brand arrowhead. */}
							<marker id="pipeline-arrow-selected" markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto" markerUnits="strokeWidth">
								<path d="M0,0 L6,3 L0,6 Z" className="pipeline-arrowfill-selected" />
							</marker>
						</defs>
						{edges}
						{tempEdge}
					</svg>
					{nodes}
					{controlNodes}
					{agents.length === 0 && controls.length === 0 ? <div className="pipeline-hint">Drag an Agent or an If from the palette onto the canvas</div> : null}
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
			{configControl ? (
				<ControlConfigPanel
					key={configControl.id}
					control={configControl}
					warnings={controlWarnings(configControl)}
					rowWarnings={branchShadowWarnings(configControl)}
					onSave={(branches) => {
						setControls((prev) => prev.map((k) => (k.id === configControl.id ? { ...k, branches } : k)));
						setConfigControlId(null);
					}}
					onClose={() => { setConfigControlId(null); }}
				/>
			) : null}
			{edgeDraft ? (
				<div
					className="pipeline-config-overlay"
					onPointerDown={(e) => { e.stopPropagation(); }}
				>
					<div className="pipeline-edge-picker">
						<h3>Connect branch</h3>
						<div className="picker-row">
							<label>{"From " + nameOf(edgeDraft.source) + " (branch)"}</label>
							<select
								value={edgeDraft.picked}
								onChange={(e) => { setEdgeDraft((d) => (d ? { ...d, picked: e.target.value } : d)); }}
							>
								{outputPortNamesOf(edgeDraft.source).map((branchName) => (
									<option key={branchName} value={branchName}>{branchName}</option>
								))}
							</select>
						</div>
						<div className="picker-row">
							<label>{"To " + nameOf(edgeDraft.target)}</label>
							<span className="picker-static">{edgeDraftTargetText()}</span>
						</div>
						<div className="picker-actions">
							<button className="pipeline-btn" onClick={() => { setEdgeDraft(null); }}>Cancel</button>
							<button className="pipeline-btn" onClick={confirmEdgeDraft}>Connect</button>
						</div>
					</div>
				</div>
			) : null}
			{ownerHandoff !== null ? (
				<div
					className="pipeline-config-overlay"
					onPointerDown={(e) => { e.stopPropagation(); }}
				>
					<div className="pipeline-edge-picker">
						<h3>Hand off emission to the if</h3>
						<div className="handoff-text">
							{nameOf(ownerHandoff.conn.source) + " declares its own output ports or bindings, but it now feeds " + ownerHandoff.control.id + " — an if owns its source's whole emission surface. Move the configuration into the branches, or clear it on the agent."}
						</div>
						<div className="picker-actions">
							<button
								className="pipeline-btn"
								title="Leave the agent's config in place — the validation strip reports the conflict"
								onClick={() => { resolveOwnerHandoff("dismiss"); }}
							>Not now</button>
							<button
								className="pipeline-btn"
								title="Drop the agent's output ports and bindings — it emits only through the if"
								onClick={() => { resolveOwnerHandoff("clear"); }}
							>Clear on the agent</button>
							<button
								className="pipeline-btn"
								title="Turn the agent's ports and bindings into this if's branches"
								onClick={() => { resolveOwnerHandoff("move"); }}
							>Move into the if</button>
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
