// dsh-agent-pipeline-canvas — shared contract types.
//
// The single authoritative set of TypeScript types for the pipeline's on-disk
// graph, validation, execution, and run contracts. Imported by the Host half
// (src/index.ts, src/runner.ts), the pure semantics modules (src/graph.ts,
// src/execution.ts), and the browser half (src/client.tsx).
//
// The browser half consumes these selectively:
//   - the runtime `validateGraph` function is imported from ./graph.ts and gets
//     BUNDLED into lib/client.js by tsdown (so both halves share one
//     implementation — no duplication);
//   - these pure type shapes are consumed as type-only imports, which the
//     compiler erases before the bundle is built, so the browser's module-table
//     require() resolution never has to answer a relative-file import.
//
// This module is intentionally PURE (no Node or browser APIs, no I/O) — types
// only — so it can be named by either half and erased without side effects.

/**
 * Per-agent settings, authored in the client's configuration panel and
 * persisted on the agent (they are settings, not run-time overrides: they are
 * saved with the graph and shape every run of that agent). Each present field
 * is forwarded as the corresponding harness `SubagentStartRequest` field (all
 * of them are supported by the `spawn` provider), so a pipeline agent can run
 * on a specific model, with restricted tools, a delegation-depth cap, or a
 * structured output schema. Absent fields inherit the defaults (the parent's
 * provider/model, unrestricted tools). The system prompt is NOT here — it is
 * a first-class field on Agent (see docs/reference/system-prompt.md).
 */
export interface AgentSettings {
	/** Absolute delegation-depth cap for the child (`SubagentStartRequest.maxDepth`). */
	maxDepth?: number;
	/** Host-Agent options; each present field replaces the parent Agent's option. */
	agentOptions?: {
		/** Provider route (must have a registered adapter at call time). */
		provider?: string;
		/** Model id interpreted by the selected provider adapter. */
		model?: string;
		/** Adapter-owned reasoning-effort id (provider-specific, free-form). */
		reasoningEffort?: string;
		/** Maximum output tokens per model request. */
		maxTokens?: number;
	};
	/** Child tool scoping: global tool names to allow (others removed) or to deny. */
	toolFilter?: {
		allow?: string[];
		deny?: string[];
	};
	/**
	 * Object-rooted JSON Schema for the child's structured result
	 * (`SubagentStartRequest.outputSchema`). A successful child returns the
	 * matching value as `SubagentResult.structured`, which the runner prefers
	 * over the raw text output.
	 */
	outputSchema?: unknown;
}

/**
 * The node edge a port renders on (edge-routing iteration 2). Geometry only —
 * the executor never reads it. Absent side = the side default ("left" for
 * input ports, "right" for output ports). At most one port of a node may
 * occupy a side (validateGraph enforces the cap).
 */
export type PortSide = "left" | "right" | "top" | "bottom";

/**
 * One named input port on an agent (the stream node model). The wire id a
 * connection refers to is `<agentId>:<name>`.
 */
export interface InputPortSpec {
	/** Port name; must be unique within the agent's `inputPorts` list. */
	name: string;
	/**
	 * Firing policy: "all-of" (default) — the node fires when EVERY wired input
	 * port holds an unconsumed message; "any-of" — when at least one does.
	 */
	policy?: "all-of" | "any-of";
	/**
	 * Delivery bound (design principle 4 — a loop budget): the max number of
	 * messages the port ACCEPTS over the run (the synthetic source's seed
	 * counts); further arrivals are dropped and recorded in the run record's
	 * `dropped` list. Positive integer; absent = unbounded. (The delivery-count
	 * reading is what makes a loop bound meaningful — a free-running consumer
	 * never overflows a backlog cap because it drains each message before the
	 * next arrives.)
	 */
	bound?: number;
	/**
	 * The node edge this port renders on (see PortSide). Absent = "left".
	 * A loop's return edge arcs over or under the node band depending on which
	 * vertical side its two ports occupy.
	 */
	side?: PortSide;
}

/**
 * One output-port binding (selective emission — conditional-dispatch §2): maps
 * a structured-output field to a port (`field == value → port`). A binding
 * without `value` is the CATCH-ALL — it matches any structured result, so it
 * belongs last. Bindings evaluate in declaration order and the FIRST match
 * selects the emission port; no match emits on no port. They evaluate only
 * against a STRUCTURED result (`settings.outputSchema` — a one-shot child's
 * `SubagentResult.structured`), so a node with bindings and no structured
 * output emits on no port; the edit panel warns when bindings are set without
 * a schema (and when a breakpoint makes structured output impossible).
 */
export interface OutputBinding {
	/** The structured-result field to compare (top-level property name). */
	field: string;
	/** The output PORT NAME to emit on when the predicate holds. */
	port: string;
	/** The value the field must equal; omitted = catch-all (matches any result). */
	value?: unknown;
}

/** One pipeline agent node on the canvas. */
export interface Agent {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/**
	 * The agent's system prompt — REAL system-prompt text. Forwarded as
	 * `SubagentStartRequest.persona` (the harness's field name), which the
	 * harness installs as the child's scoped `deployment:persona` system-prompt
	 * section (order 0), replacing that one slot for this child alone. The rest
	 * of the standard prompt — identity, delegation statement, policies, and
	 * every harness tool explanation — is inherited untouched (see
	 * docs/reference/system-prompt.md). Absent/empty keeps the deployment default (on this
	 * deployment: unset, so just the fixed harness identity line).
	 */
	systemPrompt?: string;
	x: number;
	y: number;
	/**
	 * The agent's single input port, `<id>:in` by convention. The DEFAULT port
	 * declaration: superseded by `inputPorts` when that list is present, and
	 * kept on default graphs so old files stay byte-compatible.
	 */
	input: string;
	/**
	 * The agent's single output port, `<id>:out` by convention. The DEFAULT
	 * port declaration: superseded by `outputPorts` when that list is present.
	 */
	output: string;
	/**
	 * Named input ports (the stream model). Absent → the single default port
	 * "in" (`<id>:in`, policy all-of, unbounded) — exactly today's shape. When
	 * present the list REPLACES the default; an empty list means the node has
	 * no input ports and can never fire (surfaced as starvation, not an error).
	 */
	inputPorts?: InputPortSpec[];
	/**
	 * Named output ports. Absent → the single default "out" port (`<id>:out`).
	 * A node emits on some of its output ports per firing and not on others
	 * (selective emission); an empty list means it emits nowhere.
	 */
	outputPorts?: string[];
	/**
	 * The node edge each named output port renders on (see PortSide), keyed by
	 * port name. Absent entry = "right". Purely presentational — the executor
	 * never reads it. At most one port of a node may occupy a side
	 * (validateGraph enforces the cap).
	 */
	outputPortSides?: Record<string, PortSide>;
	/**
	 * Output-port bindings (see OutputBinding): the node-field that makes
	 * emission selective — `field == value → port`, first match wins. Absent →
	 * non-selective emission (every output port, the default-graph behavior).
	 * Requires a structured result; see the warnings on the edit panel.
	 */
	bindings?: OutputBinding[];
	/** The agent's settings (see AgentSettings); absent fields inherit defaults. */
	settings?: AgentSettings;
	/**
	 * Pause-on-output breakpoint. When armed, the run pauses after this agent's
	 * output settles and before any downstream agent starts, so the user can
	 * inspect the composed input and the output and choose Resume / Rerun /
	 * Steer / Abort (see the run record types below). Absent/false runs through.
	 * A breakpointed agent runs as a CONTINUABLE subagent (steerable via harness
	 * continuation); `settings.outputSchema` is ignored for it — continuable
	 * children cannot produce structured output (a harness limitation) — and the
	 * edit panel warns when both are set.
	 */
	breakpoint?: boolean;
}

/**
 * One directed edge from a source agent's output port to a target agent's input
 * port. `sourcePort`/`targetPort` are wire port ids — `<sourceId>:<outputName>`
 * / `<targetId>:<inputName>` (`<id>:out` / `<id>:in` on default graphs, per the
 * legacy `input`/`output` strings); the on-disk / wire shape may omit or vary
 * them (a hand-writer or a legacy file); validation treats missing/mismatched
 * ports as an error, never a panic.
 */
export interface Connection {
	id: string;
	source: string;
	target: string;
	/** `<source>:out` on a default graph; `<sourceId>:<outputPortName>` in general. */
	sourcePort: string;
	/** `<target>:in` on a default graph; `<targetId>:<inputPortName>` in general. */
	targetPort: string;
}

/**
 * One branch rule of an if control (`docs/proposals/if-control.md`): the
 * decision `field == value → branch`, evaluated in declaration order, first
 * match wins. A branch without `value` — or authored `value: ""`, which
 * normalizes to absent on lowering — is the CATCH-ALL: it matches any
 * structured result and belongs last. Decision semantics ARE the executor's
 * binding semantics (see OutputBinding); the control only owns the authoring.
 */
export interface IfBranch {
	/** The branch/output-port name ("billing"); unique non-empty within the control. */
	name: string;
	/** The structured-output field to compare ("action"); required on valued branches. */
	field: string;
	/** The value the field must equal; absent (or "") = the catch-all (else). */
	value?: string;
	/**
	 * The control edge this branch tick renders on (see PortSide). Absent =
	 * "right". Geometry only — the executor never reads it; on lowering the
	 * non-default sides forward into the producing agent's `outputPortSides`.
	 */
	side?: PortSide;
}

/**
 * A first-class control node on the canvas — the fork as a real, persisted
 * graph node. Honest wiring (the file says what the canvas shows), LOWERED
 * onto the feeding agent's output ports + bindings before the kernel runs
 * (`lowerControls` in ./controls.ts): the kernel, the firing log, storage,
 * and the HTTP/SSE routes never learn controls exist. The run record's
 * immutable graph snapshot carries the HONEST controls — a resumed run
 * re-enters run() and re-lowers from the snapshot — while the lowered graph
 * itself is never persisted.
 */
export interface ControlNode {
	/** "if-N" — a separate id space from agent-N (validation flags collisions). */
	id: string;
	/** Control kind; "if" is the only kind in v1 (future controls extend the shape). */
	kind: "if";
	/** Branch rules; evaluation order = declaration order, catch-all last. */
	branches: IfBranch[];
	x: number;
	y: number;
}

/** The pipeline graph: the arrays persisted to `.agent-pipeline/pipeline.json`. */
export interface PipelineGraph {
	agents: Agent[];
	connections: Connection[];
	/**
	 * First-class control nodes (see ControlNode). ADDITIVE schema: absent →
	 * exactly today's graph, so old pipelines load and run unchanged, and a
	 * hand-authored ports+bindings graph keeps working — the if control is an
	 * authoring upgrade over the same mechanism, not a replacement.
	 */
	controls?: ControlNode[];
}

/** Stable discriminator + human-readable message for one validation problem. */
export interface ValidationError {
	code: string;
	message: string;
}

/** Graph validation result: `ok` is true exactly when `errors` is empty. */
export interface ValidationResult {
	ok: boolean;
	errors: ValidationError[];
	/**
	 * Non-fatal findings, reported alongside `errors` without affecting `ok`.
	 * Today the only source is `cycle-present`: a cycle is legal wiring for the
	 * stream executor, but the sequential runner (and topoOrder) truncates at
	 * one — worth telling the author about.
	 */
	warnings?: ValidationError[];
}

/**
 * The input an agent receives: ALWAYS an object keyed by source. A root agent
 * gets the reserved INPUT_KEY ("$input"); every other agent gets one key per
 * upstream agent id (deterministic, sorted-by-id order).
 */
export type AgentExecutionInput = Record<string, unknown>;

/**
 * The pipeline-level input value, given unmasked to every root agent under the
 * reserved INPUT_KEY.
 */
export type PipelineInput = unknown;

/** The contract's final result shape: `{ outputs: { [terminalId]: output } }`. */
export interface PipelineExecutionResult {
	outputs: Record<string, unknown>;
}

/** Classification of a graph: known ids + root/terminal/orphan sets + adjacency. */
export interface ClassifiedGraph {
	agents: string[];
	roots: string[];
	terminals: string[];
	orphans: string[];
	upstream: Record<string, string[]>;
	downstream: Record<string, string[]>;
}

// ---- The port-graph view (the stream node model) --------------------------------
// portGraph() in execution.ts derives this from the raw `{ agents, connections }`
// shape: which ports each agent declares (defaults applied), and which edges wire
// into them. Shared by validateGraph (port-wiring correctness) and the run kernel
// (per-port message queues). Like ClassifiedGraph, it is a derived view — nothing
// new is persisted.

/** One edge wired INTO an input port (the fields that matter to the receiver). */
export interface IncomingEdge {
	/** The connection's id ("" when absent). */
	connectionId: string;
	/** The upstream agent id the message will come from. */
	source: string;
	/** The upstream wire port id the edge leaves (`<sourceId>:<outputName>`). */
	sourcePort: string;
}

/** One edge wired OUT of an output port. */
export interface OutgoingEdge {
	connectionId: string;
	/** The downstream agent id the message will go to. */
	target: string;
	/** The downstream wire port id the edge enters (`<targetId>:<inputName>`). */
	targetPort: string;
}

/** One resolved input port: the declared (or default) spec plus its wired edges. */
export interface ResolvedInputPort {
	/** Port name — declared, or "in" on a default graph. */
	name: string;
	/** Wire id connections refer to: `<agentId>:<name>` (or the legacy `input` string). */
	portId: string;
	/** Delivery policy; declared, defaulting to "all-of" (invalid declared values fall back to it too — validation reports them). */
	policy: "all-of" | "any-of";
	/** Delivery bound; declared positive integer, else undefined (unbounded). */
	bound?: number;
	/** Incoming edges in connection-array order. */
	edges: IncomingEdge[];
	/** Unique upstream agent ids, sorted. */
	sources: string[];
}

/** One resolved output port: the declared (or default) name plus its wired edges. */
export interface ResolvedOutputPort {
	/** Port name — declared, or "out" on a default graph. */
	name: string;
	/** Wire id connections refer to: `<agentId>:<name>` (or the legacy `output` string). */
	portId: string;
	/** Outgoing edges in connection-array order. */
	edges: OutgoingEdge[];
	/** Unique downstream agent ids, sorted. */
	targets: string[];
}

/** One agent's resolved port surface. */
export interface PortNode {
	id: string;
	/** Input ports in declaration order (a single default port when undeclared). */
	inputs: ResolvedInputPort[];
	/** Output ports in declaration order (a single default port when undeclared). */
	outputs: ResolvedOutputPort[];
	/** Wire port id -> port; the lookup connections resolve against. */
	inputById: Record<string, ResolvedInputPort>;
	outputById: Record<string, ResolvedOutputPort>;
}

/** The port-graph view of a whole graph: agents + their resolved ports and edges. */
export interface PortGraph {
	/** Known agent ids in agent-array order. */
	ids: string[];
	byId: Record<string, PortNode>;
}

/** Input for building one agent's input object (see agentInput). */
export interface AgentInputContext {
	upstream: string[];
	upstreamOutputs: Record<string, unknown>;
	pipelineInput?: PipelineInput;
}

/** Per-agent status record reported on a run. */
export interface AgentRunRecord {
	id: string;
	label: string;
	status: string;
	output?: string;
	error?: string;
	/**
	 * The published child session id of this agent's run (`SubagentRun.id`).
	 * The child session is durable and holds the full transcript, so the
	 * client can open it for inspection; absent when the start itself failed.
	 */
	childSessionId?: string;
}

/**
 * A pipeline run request: the snapshot the browser currently shows, the
 * pipeline-level input, and the live session id (the parent Agent for the whole
 * run).
 */
export interface PipelineRunRequest {
	graph: PipelineGraph | null | undefined;
	input?: PipelineInput;
	sessionId: string;
	signal?: AbortSignal;
}

/** Successful run: contract outputs + per-agent runs + deterministic order. */
export interface PipelineRunSuccess {
	ok: true;
	outputs: Record<string, unknown>;
	runs: AgentRunRecord[];
	order: string[];
	/**
	 * True when the run stopped early because the caller aborted the signal:
	 * the agent in flight at abort time is recorded with status "aborted" and
	 * the agents after it in the topological order never ran.
	 */
	aborted?: boolean;
}

/** Failed run: invalid graph, missing parent Agent, or no provider registered. */
export interface PipelineRunFailure {
	ok: false;
	validationErrors?: ValidationError[];
	error?: string;
}

/** Discriminated union returned by the runner. */
export type PipelineRunResult = PipelineRunSuccess | PipelineRunFailure;

// ---- Durable runs -----------------------------------------------------------------
// A run is no longer a blocking request/response: POST /run starts a run
// executor in the Host process and returns a runId immediately. The executor's
// state lives in a durable record (`.agent-pipeline/runs/<runId>.json`,
// rewritten atomically on every transition) so a paused run stays controllable
// across profile restarts and page reloads. The browser follows the record over
// SSE and issues control commands (resume / rerun / steer / abort) at pause
// points. One run is active (running or paused) per (workspace, session) at
// a time — two sessions in one workspace may run concurrently.

/** Terminal-or-not lifecycle state of a whole run. */
export type RunState = "running" | "paused" | "completed" | "aborted" | "error";

/** Lifecycle status of one firing (and of a node slot in a legacy v1 record). */
export type RunFiringStatus = "pending" | "running" | "paused" | "done" | "aborted" | "error";

/**
 * One firing in the run record's FIRING LOG: one start of one node's agent
 * with one composed input. The log is the run's truth — there is deliberately
 * NO parallel per-node status/output bookkeeping (design principle 5); the
 * per-node view the UI shows is computed by projectNodes() in ./projection.ts.
 * A node that re-fires (Rerun) gets one firing per start, numbered by `seq`;
 * steering continues the SAME firing's child and updates its output in place.
 */
export interface RunFiring {
	/** Stable, start-ordered id ("f-001", "f-002", …) — log order by start. */
	firingId: string;
	nodeId: string;
	/** 1-based firing number within the node (increments on Rerun). */
	seq: number;
	status: RunFiringStatus;
	/**
	 * The composed prompt this firing started with. Written once at start and
	 * immutable — every re-firing of the node carries the SAME verbatim input,
	 * never any steering conversation content.
	 */
	input?: string;
	/** The adopted output (text, or rendered JSON for a structured one-shot result). */
	output?: string;
	error?: string;
	/** The harness stop reason of the settling epoch (completed/aborted/error/…). */
	stopReason?: string;
	/**
	 * The firing's child session id. For a continuable firing this is the
	 * durable continuable child id — stable across steering and the transcript
	 * address for inspection; a Rerun starts a NEW child, so the new firing
	 * carries a new id. For a one-shot firing it is the published run id (the
	 * child session id).
	 */
	childSessionId?: string;
	/**
	 * Output ports (names) this firing SELECTED for emission, written at
	 * emission time: every declared port for a node WITHOUT bindings, the
	 * first matched binding's port with bindings, and `[]` when a bound node
	 * selected nothing (no match, or no structured result — the honest quiet).
	 * Selection is the firing's decision, not the arrival's: a selected port
	 * whose downstream delivery a bound refused still shows here, with the
	 * refusal recorded in the record's `dropped` list. Unset for firings that
	 * never reached emission (failed, aborted, no output).
	 */
	emittedTo?: string[];
	/** ISO timestamps: when the firing started / reached a terminal status. */
	startedAt?: string;
	settledAt?: string;
	/** Reserved for per-firing token accounting (run-operations §3 — out of scope). */
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Durable EXECUTOR CONTROL state for one node — the only per-node data the
 * record still carries. Everything the UI shows is projected from the firing
 * log (./projection.ts), never stored beside it.
 */
export interface RunNodeControlState {
	/**
	 * The node's own parent anchor session id (executor spec §5): a hidden
	 * `origin: "subagent"` session that admits the node's continuable children
	 * and is their durable parent address — the header `interrupt` authorizes
	 * against and the address a post-restart steer cold-resumes from. Present
	 * only after the node's first continuable admission; the anchor handle is
	 * disposed between operations (it costs one session record, zero model
	 * calls).
	 */
	parentAnchorSessionId?: string;
}

/**
 * The durable per-run record (recordVersion 2 — the firing log), persisted per
 * workspace and streamed to the browser over SSE. `graph` is the immutable
 * snapshot the run was started from; canvas edits during a run affect only the
 * NEXT run. The executor derives its walk order from that snapshot — the order
 * is no longer persisted.
 */
export interface RunRecord {
	runId: string;
	/** Absolute workspace root the run belongs to (records live under it). */
	cwd: string;
	/** The user conversation id the run was started from. */
	sessionId: string;
	/** The record schema version (2 = the firing log). */
	recordVersion: 2;
	createdAt: string;
	updatedAt: string;
	state: RunState;
	/**
	 * The FIRING the run is paused at (when `state === "paused"`). The client
	 * derives the node via the projection; Rerun parks a NEW firing, so the
	 * pointer moves with the queue head.
	 */
	pausedAt?: string;
	/** Immutable graph snapshot. */
	graph: PipelineGraph;
	/** The pipeline-level input the run was started with. */
	input?: unknown;
	/** Max firings in flight (executor spec §1); default 4, set from POST /run. */
	maxInFlight?: number;
	/** The firing log — append-ordered, one entry per firing (start order). */
	firings: RunFiring[];
	/** Durable executor control state per node (see RunNodeControlState) — the
	 * parent anchor session ids. Empty for one-shot-only runs. */
	nodes: Record<string, RunNodeControlState>;
	/**
	 * Bound-overflow record (design principle 4): each message a port's
	 * delivery bound refused, in drop order. Written by the executor at
	 * emission; absent until the first drop.
	 */
	dropped?: Array<{ nodeId: string; port: string; from: string }>;
}

// ---- Legacy v1 record (pre-firing-log) — read-only --------------------------------
// Records without `recordVersion` were written by the sequential executor
// before the firing log. They are READ ONLY: the registry sweeps a stale v1
// `running` record to `aborted` exactly as before, finalizes a v1 `paused`
// record to `aborted` with an explanatory error (the v2 executor cannot drive
// the old shape, and a paused run has nothing in flight — the remaining cost
// is zero), and never resurrects one. Rendering goes through the projection,
// which reads both shapes.

/** Per-node status slot inside a legacy v1 record. */
export interface LegacyRunNodeState {
	status: RunFiringStatus;
	input?: string;
	output?: string;
	error?: string;
	stopReason?: string;
	childSessionId?: string;
}

/** A run record written before the firing log (no `recordVersion`). */
export interface LegacyRunRecord {
	runId: string;
	cwd: string;
	sessionId: string;
	coordinatorSessionId?: string;
	createdAt: string;
	updatedAt: string;
	state: RunState;
	/** The NODE the run was paused at (the v1 pointer is a node id). */
	pausedAt?: string;
	graph: PipelineGraph;
	input?: unknown;
	/** Deterministic topological order the v1 executor followed. */
	order: string[];
	nodes: Record<string, LegacyRunNodeState>;
}

/** One control command for a run (POST /dsh-agent-pipeline/control). */
export interface RunControlRequest {
	runId: string;
	action: "resume" | "rerun" | "steer" | "abort";
	/** Required for `steer`: the user feedback delivered to the SAME child. */
	feedback?: string;
}
