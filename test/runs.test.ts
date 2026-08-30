// Durable run registry tests — plain Node script (no framework). Run:
//   tsx test/runs.test.ts
// Exercises the executor and control plane against SCRIPTED services (the same
// fake-service style as runner.test.ts): a fake subagent seam whose continuable
// children settle when the test emits a `subagent/end` payload and whose
// ONE-SHOT children settle on demand (holdOneshots + resolveOneshot — the
// marble harness scripts one-shot interleavings too), a fake agents service
// that records parent-anchor create/resume/dispose, and a real temp directory
// for the per-workspace run records.
//
// The record is a FIRING LOG (recordVersion 2): per-node behavior is asserted
// through projectNodes() + the log — a sequential run is the special case of
// one firing per node, Rerun appends a new firing with the same verbatim
// input, and steering updates the same firing in place. The kernel cases pin
// the concurrency semantics: fan-out/fan-in (D fires once after both), the
// maxInFlight cap, bound overflow (drop + record, nothing fires), and
// quiescence with an unfilled all-of port (the waiting node is reported).
// Legacy v1 records (order + status slots) are covered read-only: the
// stale-running sweep and the paused-record finalization. Asserts
// pause/resume ordering, rerun verbatim inputs + fresh child ids, steering to
// the SAME child, abort preservation, the sweeps, the single-active-run rule,
// coordinator disposal between operations, and the degraded no-continuable
// path — all WITHOUT a live model. The P5 control-plane cases pin the
// pending-pause queue: two parks with id-order release, the crash-safe queue
// rebuild across a restart (both parked branches steerable), pause while a
// branch is in flight (output adopted and held), and abort mid-fan-out
// (interrupts + one-shot cancel + drain before finalize + no post-finalize
// commits). The P6 fail-fast cases pin the one rule: a firing settling as
// anything but `completed` — thrown, or settled refusal/max-tokens/error —
// fails the run: the halt gate closes (nothing downstream starts, even when a
// drained sibling's emission would make it fireable), in-flight siblings drain
// with their outputs preserved, the failed firing carries error + stopReason,
// a parked control wait unwinds instead of hanging, and the record byte-stabilizes
// after finalization. The P7 selective-emission cases pin conditional dispatch:
// a bound node emits only on the first matched port (the unselected branch
// never fires), the catch-all catches the no-match case, a node with bindings
// and no structured result emits on no port (honest quiet, starved downstream
// reported), the any-of join fires on whichever branch ran, the feedback/
// verdict loop ends on verdict (quiescence), and the feedback port's delivery
// bound caps the loop (drop recorded, nothing downstream of the drop). The P8
// matrix completion pins the whole-run contracts the earlier gates carried
// only partially: a dedicated minimal starvation case (an all-of port that is
// never filled goes quiet completed with the waiting node reported),
// commit-writer isolation over an OBSERVED write log (snapshots sampled during
// concurrent commits are always whole, gap-free, and never regress, and no
// commit lands after finalization), determinism (the same scripted run twice
// yields an identical firing structure, ready order by node id), and the
// DEFAULT maxInFlight of 4 on a wide fan-out. The latest-run discovery
// (`latestRunForCwd`) pins the remount path that restores the canvas's Result
// view: the newest record of any state wins (a stale running entry sweeps to
// aborted first), a live executor preempts the disk scan, and a settled run is
// served from disk.
import { RunRegistry, type RunRegistryServices } from "../lib/runs.js";
import { validateGraph } from "../lib/graph.js";
import { projectNodes } from "../lib/projection.js";
import type { LegacyRunRecord, RunRecord } from "../lib/types.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function okCheck(name: string, cond: boolean) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.error(`FAIL  ${name}`); }
}

const agent = (id: string, name: string, instructions?: string, extra: Record<string, unknown> = {}) => ({
	id, name, description: "", instructions: instructions || "",
	x: 0, y: 0, input: id + ":in", output: id + ":out", ...extra,
});
const conn = (id: string, source: string, target: string) => ({
	id, source, target, sourcePort: source + ":out", targetPort: target + ":in",
});

type EndListener = (info: { id?: string; stopReason?: string; lastAssistantMessage?: unknown }) => void;

interface HeldOneshot {
	resolve: (result: { output: Array<{ type: string; text: string }>; stopReason: string; structured?: unknown }) => void;
	reject: (error: unknown) => void;
}

/** The scripted harness: services + recording + a settle() the test drives. */
function makeHarness(options: { continuable?: boolean; holdOneshots?: boolean } = {}) {
	const continuable = options.continuable !== false;
	const holdOneshots = options.holdOneshots === true;
	const listeners = new Set<EndListener>();
	const starts: Array<{ kind: string; childId: string; label: string; prompt: string; parentId: string; request: Record<string, unknown> }> = [];
	const followups: Array<{ childId: string; text: string; parentId: string }> = [];
	const interrupts: Array<{ childId: string; parentSessionId: string }> = [];
	const anchorCreated: Array<{ sessionId: string; meta: Record<string, unknown> | undefined; agentOptions: Record<string, unknown> | undefined }> = [];
	const anchorResumed: string[] = [];
	const anchorDisposed: string[] = [];
	const liveAnchors = new Set<string>();
	const heldOneshots = new Map<string, HeldOneshot>();
	let seq = 0;

	const subagents = {
		list: () => ["spawn"],
		start: (_provider: string, req: { label?: string; prompt: Array<{ text: string }>; parent: { id: string }; signal?: AbortSignal }) => {
			seq += 1;
			starts.push({ kind: "oneshot", childId: "oneshot-" + seq, label: String(req.label), prompt: req.prompt[0].text, parentId: req.parent.id, request: req as unknown as Record<string, unknown> });
			const id = "oneshot-" + seq;
			let result: Promise<{ output: Array<{ type: string; text: string }>; stopReason: string }>;
			if (holdOneshots) {
				// Deferred: the test scripts the settlement beat (marble-style).
				// A run-signal abort rejects, mirroring the real provider.
				result = new Promise((resolve, reject) => {
					heldOneshots.set(id, { resolve, reject });
					req.signal?.addEventListener("abort", () => reject(new Error("aborted: the run signal fired")));
				});
			} else {
				result = Promise.resolve({ output: [{ type: "text", text: "<out:" + req.label + ">" }], stopReason: "completed" });
			}
			return {
				id,
				result,
				dispose: () => Promise.resolve(),
			};
		},
		...(continuable ? {
			startContinuable: async (spec: { label: string; request: { prompt: Array<{ text: string }>; parent: { id: string } } }) => {
				seq += 1;
				const childId = "child-" + seq;
				starts.push({ kind: "continuable", childId, label: spec.label, prompt: spec.request.prompt[0].text, parentId: spec.request.parent.id, request: spec.request as unknown as Record<string, unknown> });
				return { childId, messageId: "m-" + seq };
			},
			followup: async (parent: { id: string }, childId: string, content: Array<{ text: string }>) => {
				followups.push({ childId, text: content[0].text, parentId: parent.id });
				return "m-follow-" + followups.length;
			},
			interrupt: (childId: string, authority: { kind: string; parentSessionId: string }) => {
				interrupts.push({ childId, parentSessionId: authority.parentSessionId });
			},
		} : {}),
	};
	const agentsService = {
		get: (id: string) => {
			if (id === "sess") return { id: "sess", options: { provider: "ds", model: "m-1", subagentDepth: 99 } };
			if (liveAnchors.has(id)) return { id, options: {} };
			return undefined;
		},
		create: async (opts: { sessionId: string; meta?: Record<string, unknown>; agentOptions?: Record<string, unknown> }) => {
			anchorCreated.push({ sessionId: opts.sessionId, meta: opts.meta, agentOptions: opts.agentOptions });
			liveAnchors.add(opts.sessionId);
			return {
				agent: { id: opts.sessionId, options: {} },
				dispose: async () => { liveAnchors.delete(opts.sessionId); anchorDisposed.push(opts.sessionId); },
			};
		},
		resume: async (opts: { resumeSessionId: string }) => {
			anchorResumed.push(opts.resumeSessionId);
			liveAnchors.add(opts.resumeSessionId);
			return {
				agent: { id: opts.resumeSessionId, options: {} },
				dispose: async () => { liveAnchors.delete(opts.resumeSessionId); anchorDisposed.push(opts.resumeSessionId); },
			};
		},
	};
	const warnings: string[] = [];
	const services = {
		agents: agentsService,
		subagents,
		logger: { warn: (...args: unknown[]) => { warnings.push(args.join(" ")); } },
		subscribeRunEnd: (fn: EndListener) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
		sessionPersistence: {},
	} as unknown as RunRegistryServices;
	return {
		services,
		starts, followups, interrupts,
		anchorCreated, anchorResumed, anchorDisposed, liveAnchors,
		warnings,
		/** Simulate the child's epoch settling: the harness emits `subagent/end`. */
		settle(childId: string, output: string, stopReason = "completed") {
			const info = { runId: "run-" + childId, provider: "spawn", id: childId, local: true, stopReason, lastAssistantMessage: [{ type: "text", text: output }] };
			for (const listener of [...listeners]) listener(info);
		},
		/**
		 * Settle a HELD one-shot child (holdOneshots) with a successful result.
		 * `structured` is the provider's validated structured value (what an
		 * outputSchema child returns) — selective emission evaluates a node's
		 * output bindings against it.
		 */
		resolveOneshot(childId: string, output: string, stopReason = "completed", structured?: unknown) {
			const deferred = heldOneshots.get(childId);
			if (deferred === undefined) throw new Error("no held one-shot child \"" + childId + "\"");
			heldOneshots.delete(childId);
			deferred.resolve({
				output: [{ type: "text", text: output }],
				stopReason,
				...(structured !== undefined ? { structured } : {}),
			});
		},
		/** Fail a HELD one-shot child (holdOneshots): runOneAgent records the error. */
		failOneshot(childId: string, message: string) {
			const deferred = heldOneshots.get(childId);
			if (deferred === undefined) throw new Error("no held one-shot child \"" + childId + "\"");
			heldOneshots.delete(childId);
			deferred.reject(new Error(message));
		},
	};
}

/** One macrotask beat: let every pending microtask (kernel loop, writers) run. */
const beat = () => new Promise<void>((resolve) => { setTimeout(resolve, 15); });

async function withTempDir(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pipeline-runs-test-"));
	try {
		await fn(cwd);
	} finally {
		// A just-finished executor may still be writing its final state; retry the
		// recursive removal rather than failing the test on cleanup.
		await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
}

/** Poll an (async) condition until it holds, with a friendly timeout error. */
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		let good = false;
		try { good = await cond(); } catch { good = false; }
		if (good) return;
		if (Date.now() - start > ms) throw new Error("timeout waiting for: " + what);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** The node the record (in memory or on disk) is paused at, via the projection. */
function pausedNodeOf(rec: RunRecord | LegacyRunRecord): string | undefined {
	return projectNodes(rec).pausedNodeId;
}

/** Wait until the run is paused at `agentId` (durably) and return the record. */
async function waitPausedAt(registry: RunRegistry, runId: string, cwd: string, agentId: string): Promise<RunRecord> {
	let rec: RunRecord | LegacyRunRecord | null = null;
	await waitFor("paused at " + agentId, async () => {
		rec = await registry.getRun(runId, cwd);
		if (!(rec !== null && rec.state === "paused" && pausedNodeOf(rec) === agentId)) return false;
		// Require DURABILITY too: the in-memory record flips to paused one
		// commit ahead of the disk write, and the restart test reloads from disk.
		try {
			const disk = JSON.parse(await readFile(join(cwd, ".agent-pipeline", "runs", runId + ".json"), "utf8")) as RunRecord;
			return disk.state === "paused" && pausedNodeOf(disk) === agentId;
		} catch {
			return false;
		}
	});
	return rec as RunRecord;
}

/** Wait until the run reaches a terminal state and return the record. */
async function waitTerminal(registry: RunRegistry, runId: string, cwd: string): Promise<RunRecord> {
	let rec: RunRecord | LegacyRunRecord | null = null;
	await waitFor("terminal state", async () => {
		rec = await registry.getRun(runId, cwd);
		return rec !== null && (rec.state === "completed" || rec.state === "aborted" || rec.state === "error");
	});
	return rec as RunRecord;
}

// --- graph with breakpoint fields still validates (compat) ----------------
{
	const result = validateGraph({
		agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }, agent("b", "Beta", "B.")],
		connections: [conn("c1", "a", "b")],
	});
	okCheck("breakpoint graph validates", result.ok === true);
}

// --- GATE: a sequential A→B→C run is exactly three done firings -------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B."), agent("c", "Gamma", "C.")],
			connections: [conn("c1", "a", "b"), conn("c2", "b", "c")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("log: start ok", false); return; }
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("log: run completed", done.state === "completed");
	okCheck("log: one firing per node, in walk order, all done",
		done.firings.length === 3
		&& done.firings.map((f) => f.nodeId).join() === "a,b,c"
		&& done.firings.every((f) => f.status === "done"));
	okCheck("log: firing ids are start-ordered", done.firings.map((f) => f.firingId).join() === "f-001,f-002,f-003");
	okCheck("log: composed inputs identical to the prompts sent",
		done.firings[0].input === harness.starts[0].prompt
		&& done.firings[1].input === harness.starts[1].prompt
		&& done.firings[2].input === harness.starts[2].prompt);
	okCheck("log: composed inputs match the contract framing",
		done.firings[0].input === "A.\n\n## Input\nhello"
		&& done.firings[1].input === "B.\n\n## Alpha\n<out:Alpha>"
		&& done.firings[2].input === "C.\n\n## Beta\n<out:Beta>");
	okCheck("log: timestamps on every firing", done.firings.every((f) => typeof f.startedAt === "string" && typeof f.settledAt === "string"));
	okCheck("log: v2 shape — firings present, no per-node status slots",
		done.recordVersion === 2 && Object.keys(done.nodes).length === 0 && !("order" in done));
	const p = projectNodes(done);
	okCheck("log: projection — per-node done with latest outputs",
		p.order.join() === "a,b,c"
		&& p.nodes.a.status === "done" && p.nodes.b.status === "done" && p.nodes.c.status === "done"
		&& p.nodes.c.output === "<out:Gamma>");
});

// --- breakpoint pauses before downstream; resume completes ----------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "Extract."), breakpoint: true }, agent("b", "Beta", "Summarize.")], connections: [conn("c1", "a", "b")] },
		input: "hello",
	});
	okCheck("pause: start ok", started.ok === true);
	if (!started.ok) return;
	// a starts as a continuable child, then the test settles its epoch.
	await waitFor("a's continuable start", () => harness.starts.length === 1 && harness.starts[0].kind === "continuable" && harness.starts[0].label === "Alpha");
	harness.settle(harness.starts[0].childId, "<out:after-breakpoint>");
	const rec = await waitPausedAt(registry, started.runId, cwd, "a");
	const p = projectNodes(rec);
	okCheck("pause: paused at a before b", p.nodes.a.status === "paused" && (p.nodes.b?.status ?? "pending") === "pending");
	okCheck("pause: the log holds exactly a's firing, parked with its input", rec.firings.length === 1 && rec.firings[0].nodeId === "a" && rec.firings[0].status === "paused" && rec.firings[0].input === "Extract.\n\n## Input\nhello");
	okCheck("pause: a adopted the epoch output", p.nodes.a.output === "<out:after-breakpoint>");
	okCheck("pause: a carries the durable child id", p.nodes.a.childSessionId === harness.starts[0].childId);
	okCheck("pause: pausedAt points at the firing", rec.pausedAt === rec.firings[0].firingId);
	okCheck("pause: downstream b not started", harness.starts.every((s) => s.label !== "Beta"));

	await registry.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("pause: resume completes the run", done.state === "completed");
	await waitFor("b started once", () => harness.starts.filter((s) => s.label === "Beta").length === 1);
	okCheck("pause: b runs one-shot on a's adopted output", harness.starts[1].kind === "oneshot" && harness.starts[1].prompt.includes("## Alpha\n<out:after-breakpoint>"));
	const doneP = projectNodes(done);
	okCheck("pause: b done with its own output", done.firings.length === 2 && done.firings[1].nodeId === "b" && done.firings[1].status === "done" && done.firings[1].output === "<out:Beta>" && doneP.nodes.b.status === "done");
	// The continuable child parents to its NODE's parent anchor; the one-shot
	// child stays parented to the session agent (unchanged behavior).
	const anchorId = rec.nodes.a?.parentAnchorSessionId as string;
	okCheck("pause: continuable child parented to its node's parent anchor", harness.starts[0].parentId === anchorId);
	okCheck("pause: one-shot child parented to the session agent", harness.starts[1].parentId === "sess");
});

// --- multiple breakpoints pause in sequence, in topo order ----------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A.", { breakpoint: true }),
				agent("b", "Beta", "B.", { breakpoint: true }),
				agent("c", "Gamma", "C."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "b", "c")],
		},
		input: "go",
	});
	if (!started.ok) { okCheck("sequence: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:a>");
	const first = await waitPausedAt(registry, started.runId, cwd, "a");
	okCheck("sequence: first pause at a", pausedNodeOf(first) === "a");
	await registry.control(started.runId, { action: "resume" }, cwd);
	await waitFor("b's continuable start", () => harness.starts.filter((s) => s.label === "Beta").length === 1);
	harness.settle(harness.starts[1].childId, "<out:b>");
	const second = await waitPausedAt(registry, started.runId, cwd, "b");
	okCheck("sequence: second pause at b (c never started)", pausedNodeOf(second) === "b" && harness.starts.every((s) => s.label !== "Gamma"));
	await registry.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("sequence: completes after both breakpoints, three done firings",
		done.state === "completed" && done.firings.length === 3 && done.firings.every((f) => f.status === "done"));
});

// --- terminal breakpoint pauses BEFORE finalization ------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [agent("a", "Alpha", "A."), { ...agent("b", "Beta", "B."), breakpoint: true }], connections: [conn("c1", "a", "b")] },
		input: "x",
	});
	if (!started.ok) { okCheck("terminal: start ok", false); return; }
	await waitFor("b's continuable start", () => harness.starts.filter((s) => s.label === "Beta").length === 1);
	harness.settle(harness.starts[1].childId, "<out:Beta>");
	const rec = await waitPausedAt(registry, started.runId, cwd, "b");
	okCheck("terminal: pauses at the terminal agent", rec.state === "paused" && pausedNodeOf(rec) === "b");
	await registry.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("terminal: resume finalizes completed", done.state === "completed" && projectNodes(done).nodes.b.output === "<out:Beta>");
});

// --- rerun: a NEW firing with the verbatim input; steering the same firing --
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "Sum the facts."), breakpoint: true }], connections: [] },
		input: "the input",
	});
	if (!started.ok) { okCheck("rerun: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:initial>");
	const first = await waitPausedAt(registry, started.runId, cwd, "a");
	const firstP = projectNodes(first);
	const originalInput = firstP.nodes.a.input as string;
	okCheck("rerun: input composed once", originalInput.includes("Sum the facts.") && originalInput.includes("## Input\nthe input"));
	const firstChildId = firstP.nodes.a.childSessionId as string;
	okCheck("rerun: first child started", firstChildId === harness.starts[0].childId);

	// Steer the first firing's child; the SAME firing adopts the new output.
	await registry.control(started.runId, { action: "steer", feedback: "make it shorter" }, cwd);
	await waitFor("followup delivered", () => harness.followups.length === 1);
	okCheck("rerun: steer went to the SAME child", harness.followups[0].childId === firstChildId && harness.followups[0].text === "make it shorter");
	okCheck("rerun: steer parented to the node's parent anchor", harness.followups[0].parentId === first.nodes.a?.parentAnchorSessionId);
	harness.settle(firstChildId, "<out:steered-1>");
	const afterSteer1 = await waitPausedAt(registry, started.runId, cwd, "a");
	const afterSteer1P = projectNodes(afterSteer1);
	okCheck("rerun: steering epoch output adopted into the SAME firing",
		afterSteer1.firings.length === 1 && afterSteer1.firings[0].output === "<out:steered-1>" && afterSteer1P.nodes.a.output === "<out:steered-1>");
	okCheck("rerun: still the same child after steer", afterSteer1P.nodes.a.childSessionId === firstChildId);

	// Steer AGAIN — repeatable.
	await registry.control(started.runId, { action: "steer", feedback: "shorter still" }, cwd);
	await waitFor("second followup", () => harness.followups.length === 2);
	okCheck("rerun: second steer same child", harness.followups[1].childId === firstChildId);
	harness.settle(firstChildId, "<out:steered-2>");
	await waitPausedAt(registry, started.runId, cwd, "a");
	okCheck("rerun: second steering output adopted", true);

	// Rerun: a NEW firing (seq 2) with the verbatim ORIGINAL input.
	await registry.control(started.runId, { action: "rerun" }, cwd);
	await waitFor("fresh child started", () => harness.starts.length === 2);
	okCheck("rerun: second start is continuable with the SAME prompt", harness.starts[1].kind === "continuable" && harness.starts[1].prompt === originalInput);
	harness.settle(harness.starts[1].childId, "<out:rerun>");
	const second = await waitPausedAt(registry, started.runId, cwd, "a");
	const secondP = projectNodes(second);
	okCheck("rerun: the log holds two firings — superseded parked one + the new one",
		second.firings.length === 2
		&& second.firings[0].seq === 1 && second.firings[0].status === "paused" && second.firings[0].output === "<out:steered-2>"
		&& second.firings[1].seq === 2 && second.firings[1].input === originalInput && second.firings[1].status === "paused");
	const secondChildId = secondP.nodes.a.childSessionId as string;
	okCheck("rerun: fresh child id (old transcript preserved)", secondChildId !== firstChildId && secondChildId === harness.starts[1].childId);
	okCheck("rerun: projection follows the newest firing", secondP.nodes.a.output === "<out:rerun>" && secondP.nodes.a.status === "paused");

	// Steering after the rerun targets the NEW firing's child.
	await registry.control(started.runId, { action: "steer", feedback: "one more pass" }, cwd);
	await waitFor("third followup", () => harness.followups.length === 3);
	okCheck("rerun: steering after rerun targets the new child", harness.followups[2].childId === secondChildId);
	harness.settle(secondChildId, "<out:final>");
	await waitPausedAt(registry, started.runId, cwd, "a");
	await registry.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	const doneP = projectNodes(done);
	okCheck("rerun: completes with the final adopted output; the released firing is done",
		done.state === "completed" && done.pausedAt === undefined
		&& doneP.nodes.a.status === "done" && doneP.nodes.a.output === "<out:final>"
		&& done.firings[1].status === "done" && done.firings[0].status === "paused");
});

// --- anchor lifecycle: created per node with depth 0, disposed between ops,
// --- never live at a settlement (executor spec §8)
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }], connections: [] },
		input: "x",
	});
	if (!started.ok) { okCheck("anchor: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:1>");
	const rec = await waitPausedAt(registry, started.runId, cwd, "a");
	okCheck("anchor: exactly one created for the node", harness.anchorCreated.length === 1);
	const created = harness.anchorCreated[0];
	okCheck("anchor: persisted in the record's nodes map", rec.nodes.a?.parentAnchorSessionId === created.sessionId);
	okCheck("anchor: the record carries no shared coordinator field", !("coordinatorSessionId" in rec));
	okCheck("anchor: meta origin/depth/parent", created.meta?.origin === "subagent" && created.meta?.delegationDepth === 0 && created.meta?.parentSession === "sess" && created.meta?.cwd === cwd);
	okCheck("anchor: options mirrored minus subagentDepth", created.agentOptions?.provider === "ds" && created.agentOptions?.subagentDepth === undefined);
	okCheck("anchor: disposed after the start acceptance", harness.anchorDisposed.includes(created.sessionId) && !harness.liveAnchors.has(created.sessionId));
	// Steer: resumed on demand, disposed again right after the followup.
	await registry.control(started.runId, { action: "steer", feedback: "go on" }, cwd);
	await waitFor("followup", () => harness.followups.length === 1);
	okCheck("anchor: resumed for the steer", harness.anchorResumed.includes(created.sessionId));
	await waitFor("anchor re-disposed", () => harness.anchorDisposed.filter((id) => id === created.sessionId).length >= 2);
	okCheck("anchor: no live anchor when the child settles (notice dropped, no model call)", !harness.liveAnchors.has(created.sessionId));
	harness.settle(projectNodes(rec).nodes.a.childSessionId as string, "<out:yes>");
	await waitPausedAt(registry, started.runId, cwd, "a");
	okCheck("anchor: still no live anchor after the settlement", harness.liveAnchors.size === 0);
});

// --- abort: completed outputs preserved; run finalized aborted --------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [agent("a", "Alpha", "A."), { ...agent("b", "Beta", "B."), breakpoint: true }], connections: [conn("c1", "a", "b")] },
		input: "x",
	});
	if (!started.ok) { okCheck("abort: start ok", false); return; }
	await waitFor("b's continuable start", () => harness.starts.filter((s) => s.label === "Beta").length === 1);
	harness.settle(harness.starts[1].childId, "<out:Beta>");
	await waitPausedAt(registry, started.runId, cwd, "b");
	await registry.control(started.runId, { action: "abort" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	const p = projectNodes(done);
	okCheck("abort: run marked aborted", done.state === "aborted");
	okCheck("abort: the parked firing is aborted with its output kept in the log",
		done.firings.length === 2 && done.firings[1].status === "aborted" && done.firings[1].output === "<out:Beta>" && typeof done.firings[1].settledAt === "string");
	okCheck("abort: completed upstream output preserved", p.nodes.a.status === "done" && p.nodes.a.output === "<out:Alpha>");
	okCheck("abort: paused node reads aborted with output kept", p.nodes.b.status === "aborted" && p.nodes.b.output === "<out:Beta>");
});

// --- abort mid-flight interrupts the live continuable child -----------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [agent("a", "Alpha", "A."), { ...agent("b", "Beta", "B."), breakpoint: true }], connections: [conn("c1", "a", "b")] },
		input: "x",
	});
	if (!started.ok) { okCheck("abort-flight: start ok", false); return; }
	// a completes one-shot on its own; abort while b's initial epoch is in
	// flight (the executor waits for the epoch's settlement that never comes).
	await waitFor("b's child started", () => harness.starts.filter((s) => s.label === "Beta").length === 1);
	await registry.control(started.runId, { action: "abort" }, cwd);
	// The abort finalizes via the signal (the harness interrupt stop reason is
	// not required for the run to settle).
	const rec = await waitTerminal(registry, started.runId, cwd);
	const p = projectNodes(rec);
	const bChild = p.nodes.b.childSessionId as string;
	okCheck("abort-flight: interrupt sent to the live child via the node's durable anchor address",
		harness.interrupts.some((i) => i.childId === bChild && i.parentSessionId === rec.nodes.b?.parentAnchorSessionId));
	okCheck("abort-flight: run aborted with the in-flight firing aborted", rec.state === "aborted" && p.nodes.b.status === "aborted");
});

// --- stale v2 `running` sweep: in-flight firing aborted, outputs intact -----
await withTempDir(async (cwd) => {
	// Simulate a record left behind by a dead process: a done, b in flight.
	const stale: RunRecord = {
		runId: "stale-v2",
		cwd,
		sessionId: "sess",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "running",
		graph: { agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
		input: "x",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "done", input: "a prompt", output: "<out:Alpha>", stopReason: "completed", childSessionId: "oneshot-1", startedAt: "t", settledAt: "t" },
			{ firingId: "f-002", nodeId: "b", seq: 1, status: "running", input: "b prompt", childSessionId: "child-9", startedAt: "t" },
		],
		nodes: {},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "stale-v2.json"), JSON.stringify(stale, null, 2));
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const active = await registry.activeRunForCwd(cwd);
	okCheck("sweep: stale run is not active", active === null);
	const swept = await registry.getRun("stale-v2", cwd);
	okCheck("sweep: record swept to aborted", swept !== null && swept.state === "aborted");
	okCheck("sweep: the in-flight firing is aborted", swept !== null && swept.firings[1].status === "aborted" && typeof swept.firings[1].settledAt === "string");
	okCheck("sweep: completed firing + output intact", swept !== null && swept.firings[0].status === "done" && swept.firings[0].output === "<out:Alpha>");
	okCheck("sweep: projection agrees", swept !== null && projectNodes(swept).nodes.b.status === "aborted" && projectNodes(swept).nodes.a.output === "<out:Alpha>");
	// Swept terminal run accepts no control commands.
	const controlled = await registry.control("stale-v2", { action: "resume" }, cwd);
	okCheck("sweep: terminal run rejects control", controlled.ok === false);
});

// --- latestRunForCwd: the remount discovery path (canvas Result restoration) -
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	okCheck("latest: no runs directory -> null", (await registry.latestRunForCwd(cwd)) === null);
	// A completed record, then a NEWER stale-running one left by a dead process:
	// the stale one sweeps to aborted and wins as the latest (newest updatedAt).
	const older: RunRecord = {
		runId: "older-done",
		cwd,
		sessionId: "sess",
		createdAt: new Date(Date.now() - 120000).toISOString(),
		updatedAt: new Date(Date.now() - 60000).toISOString(),
		state: "completed",
		graph: { agents: [agent("a", "Alpha", "A.")], connections: [] },
		input: "x",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "done", input: "a prompt", output: "<out:Alpha>", stopReason: "completed", childSessionId: "oneshot-1", startedAt: "t", settledAt: "t" },
		],
		nodes: {},
	};
	const newer: RunRecord = {
		runId: "newer-stale",
		cwd,
		sessionId: "sess",
		createdAt: new Date(Date.now() - 30000).toISOString(),
		updatedAt: new Date().toISOString(),
		state: "running",
		graph: { agents: [agent("a", "Alpha", "A.")], connections: [] },
		input: "y",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "running", input: "a prompt", startedAt: "t" },
		],
		nodes: {},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "older-done.json"), JSON.stringify(older, null, 2));
	await writeFile(join(cwd, ".agent-pipeline", "runs", "newer-stale.json"), JSON.stringify(newer, null, 2));
	const latest = await registry.latestRunForCwd(cwd);
	okCheck("latest: the newest record wins regardless of state", latest !== null && latest.runId === "newer-stale");
	okCheck("latest: the stale running record is swept first", latest !== null && latest.state === "aborted");
	okCheck("latest: the swept record's in-flight firing is honestly aborted",
		latest !== null && projectNodes(latest).nodes.a.status === "aborted");
	okCheck("latest: the older completed record is untouched on disk",
		(await registry.getRun("older-done", cwd)) !== null && projectNodes((await registry.getRun("older-done", cwd)) as RunRecord).nodes.a.status === "done");
	okCheck("latest: activeRunForCwd still reports nothing active", (await registry.activeRunForCwd(cwd)) === null);
});

// --- latestRunForCwd: a live executor is the latest run, disk after settle ---
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [agent("a", "Alpha", "A.")], connections: [] },
		input: "hello",
	});
	if (!started.ok) { okCheck("latest-live: start ok", false); return; }
	const live = await registry.latestRunForCwd(cwd);
	okCheck("latest-live: the active run is reported while in memory",
		live !== null && live.runId === started.runId && live.state === "running");
	const done = await waitTerminal(registry, started.runId, cwd);
	const settled = await registry.latestRunForCwd(cwd);
	okCheck("latest-live: after settlement the completed record is reported from disk",
		done.state === "completed" && settled !== null && settled.runId === started.runId && settled.state === "completed");
});

// --- latestRunForCwd: a stampless record competes on createdAt, never pins ---
// Only hand-edited files can lack stamps; the pick must still stay sane.
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const base = {
		runId: "", cwd, sessionId: "sess", createdAt: "", updatedAt: "",
		state: "completed" as const,
		graph: { agents: [agent("a", "Alpha", "A.")], connections: [] },
		input: "x", recordVersion: 2, firings: [], nodes: {},
	};
	const olderDone = { ...base, runId: "older-done", createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString() };
	const newerStampless = { ...base, runId: "newer-stampless", createdAt: new Date().toISOString() };
	delete (newerStampless as { updatedAt?: string }).updatedAt; // createdAt competes
	const blank = { ...base, runId: "blank" };
	delete (blank as { createdAt?: string }).createdAt;
	delete (blank as { updatedAt?: string }).updatedAt; // no stamps: loses to everything
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	for (const rec of [olderDone, newerStampless, blank]) {
		await writeFile(join(cwd, ".agent-pipeline", "runs", rec.runId + ".json"), JSON.stringify(rec, null, 2));
	}
	const latest = await registry.latestRunForCwd(cwd);
	okCheck("latest-stamp: the stampless record wins via createdAt, the stampless blank never pins",
		latest !== null && latest.runId === "newer-stampless");
});

// --- stale LEGACY v1 record: same sweep semantics, read-only ----------------
await withTempDir(async (cwd) => {
	const stale: LegacyRunRecord = {
		runId: "stale-v1",
		cwd,
		sessionId: "sess",
		coordinatorSessionId: "coord-1",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "running",
		graph: { agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
		input: "x",
		order: ["a", "b"],
		nodes: {
			a: { status: "done", output: "<out:Alpha>", childSessionId: "oneshot-1", stopReason: "completed" },
			b: { status: "running", input: "b prompt", childSessionId: "child-9" },
		},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "stale-v1.json"), JSON.stringify(stale, null, 2));
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const active = await registry.activeRunForCwd(cwd);
	okCheck("v1-sweep: stale run is not active", active === null);
	const swept = await registry.getRun("stale-v1", cwd);
	okCheck("v1-sweep: record swept to aborted", swept !== null && swept.state === "aborted");
	okCheck("v1-sweep: in-flight node aborted, outputs intact",
		swept !== null && swept.state === "aborted" && projectNodes(swept).nodes.b.status === "aborted"
		&& projectNodes(swept).nodes.a.status === "done" && projectNodes(swept).nodes.a.output === "<out:Alpha>");
	const controlled = await registry.control("stale-v1", { action: "resume" }, cwd);
	okCheck("v1-sweep: terminal run rejects control", controlled.ok === false);
});

// --- LEGACY v1 PAUSED record: finalized aborted with an explanatory error ---
await withTempDir(async (cwd) => {
	const parked: LegacyRunRecord = {
		runId: "parked-v1",
		cwd,
		sessionId: "sess",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "paused",
		pausedAt: "b",
		graph: { agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
		input: "x",
		order: ["a", "b"],
		nodes: {
			a: { status: "done", output: "<out:Alpha>", childSessionId: "oneshot-1", stopReason: "completed" },
			b: { status: "paused", input: "b prompt", output: "<out:Beta>", childSessionId: "child-3", stopReason: "completed" },
		},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "parked-v1.json"), JSON.stringify(parked, null, 2));
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	// The v1 pause is NOT resurrected: loading the workspace finalizes it.
	const active = await registry.activeRunForCwd(cwd);
	okCheck("v1-paused: not resurrected as active", active === null);
	const finalized = await registry.getRun("parked-v1", cwd);
	const p = projectNodes(finalized as LegacyRunRecord);
	okCheck("v1-paused: finalized aborted", finalized !== null && finalized.state === "aborted");
	okCheck("v1-paused: the parked node carries the explanatory error",
		p.nodes.b.status === "aborted" && (p.nodes.b.error ?? "").includes("cannot be resumed"));
	okCheck("v1-paused: completed output preserved", p.nodes.a.status === "done" && p.nodes.a.output === "<out:Alpha>" && p.nodes.b.output === "<out:Beta>");
	const controlled = await registry.control("parked-v1", { action: "resume" }, cwd);
	okCheck("v1-paused: accepts no control commands", controlled.ok === false);
});

// --- paused record survives a restart: resurrected fully controllable ------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry1 = new RunRegistry(harness.services);
	const started = await registry1.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }, agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
		input: "persist me",
	});
	if (!started.ok) { okCheck("restart: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:before-restart>");
	const before = await waitPausedAt(registry1, started.runId, cwd, "a");
	const childId = projectNodes(before).nodes.a.childSessionId as string;
	const anchorId = before.nodes.a?.parentAnchorSessionId as string;
	// "Restart": a brand-new registry over the same workspace.
	const registry2 = new RunRegistry(harness.services);
	const discovered = await registry2.activeRunForCwd(cwd);
	const discoveredP = discovered !== null ? projectNodes(discovered) : null;
	okCheck("restart: paused run discovered via the workspace",
		discovered !== null && discovered.runId === started.runId && discovered.state === "paused" && discoveredP?.pausedNodeId === "a");
	okCheck("restart: the node's anchor id preserved", discovered?.nodes.a?.parentAnchorSessionId === anchorId);
	// Steering after the restart: the node's anchor cold-resumed, SAME child, then resume.
	await registry2.control(started.runId, { action: "steer", feedback: "post-restart steer" }, cwd);
	await waitFor("post-restart followup", () => harness.followups.length === 1);
	okCheck("restart: followup to the SAME child", harness.followups[0].childId === childId);
	okCheck("restart: the node's anchor cold-resumed for the steer", harness.anchorResumed.includes(anchorId));
	okCheck("restart: steer parented to the resumed anchor", harness.followups[0].parentId === anchorId);
	harness.settle(childId, "<out:after-restart>");
	await waitPausedAt(registry2, started.runId, cwd, "a");
	await registry2.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry2, started.runId, cwd);
	okCheck("restart: resume after restart completes", done.state === "completed" && projectNodes(done).nodes.b.status === "done");
	okCheck("restart: downstream used the post-restart output", harness.starts.find((s) => s.label === "Beta")?.prompt.includes("<out:after-restart>") === true);
});

// --- single active run per workspace (409 semantics) ------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const first = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }], connections: [] },
		input: "x",
	});
	okCheck("single: first start ok", first.ok === true);
	if (!first.ok) return;
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:1>");
	await waitPausedAt(registry, first.runId, cwd, "a");
	const second = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }], connections: [] },
		input: "y",
	});
	okCheck("single: second start rejected with the active run id", second.ok === false && second.activeRunId === first.runId);
	// A DIFFERENT workspace may run concurrently.
	const other = await registry.startRun({
		sessionId: "sess",
		cwd: join(cwd, "other"),
		graph: { agents: [{ ...agent("a", "Alpha2", "A."), breakpoint: true }], connections: [] },
		input: "x",
	});
	okCheck("single: other workspace allowed", other.ok === true);
});

// --- degraded deployment: no continuable support ----------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ continuable: false });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [agent("a", "Alpha", "A."), { ...agent("b", "Beta", "B."), breakpoint: true }], connections: [conn("c1", "a", "b")] },
		input: "x",
	});
	okCheck("degraded: start ok", started.ok === true);
	if (!started.ok) return;
	// a runs one-shot (no breakpoint), b runs one-shot and STILL pauses.
	const rec = await waitPausedAt(registry, started.runId, cwd, "b");
	const p = projectNodes(rec);
	okCheck("degraded: breakpointed agent ran one-shot and paused",
		harness.starts[1].kind === "oneshot" && rec.firings.length === 2 && rec.firings[1].nodeId === "b" && p.nodes.b.status === "paused");
	okCheck("degraded: no parent anchor ever created", harness.anchorCreated.length === 0);
	// Steering is rejected with a typed error; rerun works.
	const steer = await registry.control(started.runId, { action: "steer", feedback: "nope" }, cwd);
	okCheck("degraded: steering rejected", steer.ok === false);
	const rerun = await registry.control(started.runId, { action: "rerun" }, cwd);
	okCheck("degraded: rerun accepted", rerun.ok === true);
	await waitFor("degraded rerun start", () => harness.starts.length === 3);
	okCheck("degraded: rerun is a fresh one-shot", harness.starts[2].kind === "oneshot");
	okCheck("degraded: rerun used the verbatim composed input", harness.starts[2].prompt === p.nodes.b.input);
	okCheck("degraded: rerun appended a second firing with the same input",
		harness.starts[2].prompt === rec.firings[2].input && rec.firings[2].input === rec.firings[1].input);
	await waitPausedAt(registry, started.runId, cwd, "b");
	await registry.control(started.runId, { action: "resume" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("degraded: resume completes", done.state === "completed");
});

// --- wrong-state control commands get typed errors --------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }], connections: [] },
		input: "x",
	});
	if (!started.ok) { okCheck("typed: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:1>");
	await waitPausedAt(registry, started.runId, cwd, "a");
	const emptySteer = await registry.control(started.runId, { action: "steer", feedback: "   " }, cwd);
	okCheck("typed: empty steer feedback rejected", emptySteer.ok === false);
	const badAction = await registry.control(started.runId, { action: "explode" }, cwd);
	okCheck("typed: unknown action rejected", badAction.ok === false);
	const unknown = await registry.control("no-such-run", { action: "resume" }, cwd);
	okCheck("typed: unknown run rejected", unknown.ok === false);
});

// --- GATE P3: fan-out/fan-in — B and C run together; D fires once after both
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B."), agent("c", "Gamma", "C."), agent("d", "Delta", "D.")],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("fan: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	// B and C are admitted together the moment A emits.
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	okCheck("fan: b and c start concurrently after a, in id order",
		harness.starts.slice(1).map((s) => s.label).join(",") === "Beta,Gamma");
	// Settle C first: all-of holds one unconsumed message per wired source, so
	// D's single shared port waits for Beta.
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	harness.resolveOneshot(cChild, "<out:Gamma>");
	await beat();
	okCheck("fan: d waits while the slower branch is pending", harness.starts.length === 3);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	harness.resolveOneshot(bChild, "<out:Beta>");
	await waitFor("d started once both arrived", () => harness.starts.length === 4);
	okCheck("fan: d fires exactly once, strictly after the second settle", harness.starts[3].label === "Delta");
	harness.resolveOneshot(harness.starts[3].childId, "<out:Delta>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("fan: run completed with four done firings",
		done.state === "completed" && done.firings.length === 4 && done.firings.every((f) => f.status === "done"));
	okCheck("fan: d fired exactly once", done.firings.filter((f) => f.nodeId === "d").length === 1);
	okCheck("fan: d composed both sections in sorted order despite the out-of-order settles",
		done.firings[3].input === "D.\n\n## Beta\n<out:Beta>\n\n## Gamma\n<out:Gamma>");
});

// --- GATE P3: a wide fan-out respects maxInFlight ----------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const wide = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id, i) => agent(id, "W" + (i + 1), id + "."));
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [agent("a", "Alpha", "A."), ...wide],
			connections: wide.map((w) => conn("wc-" + w.id, "a", w.id)),
		},
		input: "fan",
		maxInFlight: 2,
	});
	if (!started.ok) { okCheck("cap: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	const rec = await registry.getRun(started.runId, cwd);
	okCheck("cap: the record carries the resolved cap", rec !== null && (rec as RunRecord).maxInFlight === 2);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("first two branches admitted", () => harness.starts.length === 3);
	okCheck("cap: exactly maxInFlight branches admitted, in id order",
		harness.starts.slice(1).map((s) => s.label).sort().join(",") === "W1,W2");
	const childOf = (label: string) => harness.starts.find((s) => s.label === label)!.childId;
	harness.resolveOneshot(childOf("W1"), "<out:w1>");
	await waitFor("third branch admitted after the first settle", () => harness.starts.length === 4);
	okCheck("cap: a branch starts only once a slot frees", harness.starts[3].label === "W3");
	harness.resolveOneshot(childOf("W2"), "<out:w2>");
	await waitFor("fourth branch admitted", () => harness.starts.length === 5);
	okCheck("cap: admission stays in id order", harness.starts[4].label === "W4");
	harness.resolveOneshot(childOf("W3"), "<out:w3>");
	harness.resolveOneshot(childOf("W4"), "<out:w4>");
	await waitFor("last two branches admitted", () => harness.starts.length === 7);
	okCheck("cap: the tail branches are W5 and W6",
		harness.starts.slice(5).map((s) => s.label).sort().join(",") === "W5,W6");
	harness.resolveOneshot(childOf("W5"), "<out:w5>");
	harness.resolveOneshot(childOf("W6"), "<out:w6>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("cap: completes with every branch done",
		done.state === "completed" && done.firings.length === 7 && done.firings.every((f) => f.status === "done"));
});

// --- GATE P3: bound overflow drops + records without firing the node ---------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				agent("b", "Beta", "B."),
				agent("c", "Gamma", "C."),
				{ ...agent("d", "Delta", "D."), inputPorts: [{ name: "in", bound: 1 }] },
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("bound: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("b and c admitted", () => harness.starts.length === 3);
	const childOf = (label: string) => harness.starts.find((s) => s.label === label)!.childId;
	// Both messages race into d's single bounded port; d cannot start between
	// them (all-of needs both sources), so the second arrival overflows.
	harness.resolveOneshot(childOf("Beta"), "<out:Beta>");
	harness.resolveOneshot(childOf("Gamma"), "<out:Gamma>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("bound: the run still ends at quiescence", done.state === "completed");
	okCheck("bound: the overflow is recorded against the port",
		JSON.stringify(done.dropped) === JSON.stringify([{ nodeId: "d", port: "in", from: "c" }]));
	okCheck("bound: d never fired — the dropped message fires nothing", done.firings.every((f) => f.nodeId !== "d"));
	okCheck("bound: a, b, c all done", done.firings.length === 3 && done.firings.every((f) => f.status === "done"));
	okCheck("bound: the starved join surfaces in the run report",
		harness.warnings.some((w) => w.includes("waiting nodes: d")));
});

// --- GATE P6: a failed firing FAILS THE RUN (executor spec §2 — one rule, no
// continue-on-error): downstream never fires, the completed upstream is
// preserved, and the failed firing carries its error + stopReason -------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, target: string, targetPort: string) => ({
		id, source, target, sourcePort: source + ":out", targetPort,
	});
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				agent("f", "Failer", "F."),
				{ ...agent("d", "Delta", "D."), inputPorts: [{ name: "p1" }, { name: "p2" }] },
			],
			connections: [connP("c1", "a", "d", "d:p1"), conn("c2", "a", "f"), connP("c3", "f", "d", "d:p2")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("failfast: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:A>");
	await waitFor("f started", () => harness.starts.length === 2);
	// f fails: the run fails fast — the halt gate closes (d could not start
	// anyway with p2 unfilled) and the run finalizes error, not completed.
	harness.failOneshot(harness.starts[1].childId, "boom");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("failfast: the run finalizes error (no continue-on-error)", done.state === "error");
	okCheck("failfast: d never fires", done.firings.every((f) => f.nodeId !== "d"));
	okCheck("failfast: the failed firing carries its error + stopReason",
		done.firings.some((f) => f.nodeId === "f" && f.status === "error" && (f.error ?? "").includes("boom") && f.stopReason === "error" && typeof f.settledAt === "string"));
	okCheck("failfast: the completed upstream is preserved",
		done.firings.some((f) => f.nodeId === "a" && f.status === "done" && f.output === "<out:A>"));
});

// --- GATE P6: a one-shot that settles WITHOUT throwing but not `completed`
// (the harness resolves, never rejects, a child-level failure) fails the run —
// for every non-completed stop reason in the harness vocabulary ---------------
for (const reason of ["error", "refusal", "max-tokens"]) {
	await withTempDir(async (cwd) => {
		const harness = makeHarness({ holdOneshots: true });
		const registry = new RunRegistry(harness.services);
		const started = await registry.startRun({
			sessionId: "sess",
			cwd,
			graph: { agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
			input: "x",
		});
		if (!started.ok) { okCheck("settle(" + reason + "): start ok", false); return; }
		await waitFor("a started", () => harness.starts.length === 1);
		harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
		await waitFor("b started", () => harness.starts.length === 2);
		// b settles with a non-completed stop reason and a partial output.
		harness.resolveOneshot(harness.starts[1].childId, "<out:partial-beta>", reason);
		const done = await waitTerminal(registry, started.runId, cwd);
		okCheck("settle(" + reason + "): the run finalized error", done.state === "error");
		okCheck("settle(" + reason + "): the firing is errored with the stop reason + typed error",
			done.firings.length === 2
			&& done.firings[1].status === "error"
			&& done.firings[1].stopReason === reason
			&& (done.firings[1].error ?? "").includes(reason));
		okCheck("settle(" + reason + "): the partial output stays in the log; the transcript address is kept",
			done.firings[1].output === "<out:partial-beta>" && typeof done.firings[1].childSessionId === "string");
		okCheck("settle(" + reason + "): the completed upstream is preserved",
			done.firings[0].status === "done" && done.firings[0].output === "<out:Alpha>");
	});
}

// --- GATE P6: a continuable (breakpointed) epoch settling non-completed fails
// the run — NO park (nothing to decide), no downstream, partial output kept ---
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }, agent("b", "Beta", "B.")], connections: [conn("c1", "a", "b")] },
		input: "x",
	});
	if (!started.ok) { okCheck("failbp: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:partial-a>", "max-tokens");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("failbp: the run finalized error without ever parking", done.state === "error" && done.pausedAt === undefined);
	okCheck("failbp: the firing carries the stop reason + typed error",
		done.firings.length === 1
		&& done.firings[0].status === "error"
		&& done.firings[0].stopReason === "max-tokens"
		&& (done.firings[0].error ?? "").includes("max-tokens"));
	okCheck("failbp: the partial epoch output is kept", done.firings[0].output === "<out:partial-a>");
	okCheck("failbp: downstream never started", harness.starts.every((s) => s.label !== "Beta"));
});

// --- GATE P6: fail-fast mid-fan-out — the gate closes on the FIRST failure so
// nothing downstream starts even when a later sibling's emission makes it
// fireable; the in-flight sibling DRAINS (paid turn settles, output preserved);
// the record stays live (running) until everything recorded -------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, target: string, targetPort: string) => ({
		id, source, target, sourcePort: source + ":out", targetPort,
	});
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				agent("b", "Beta", "B."),
				agent("c", "Gamma", "C."),
				{ ...agent("d", "Delta", "D."), inputPorts: [{ name: "join", policy: "any-of" }] },
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), connP("c3", "b", "d", "d:join"), connP("c4", "c", "d", "d:join")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("failfan: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	// C fails FIRST, while b is still in flight: the run is failing.
	harness.resolveOneshot(cChild, "<out:partial-gamma>", "refusal");
	await waitFor("c's firing recorded the refusal", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		const c = cur.firings.find((f) => f.nodeId === "c");
		return c?.status === "error" && c.stopReason === "refusal" && (c.error ?? "").includes("refusal");
	});
	const draining = await registry.getRun(started.runId, cwd) as RunRecord;
	okCheck("failfan: the run is still RUNNING while the sibling drains (live, not finalized)", draining.state === "running");
	okCheck("failfan: the failed firing errored with its partial output kept in the log", draining.firings.find((f) => f.nodeId === "c")?.output === "<out:partial-gamma>" && draining.firings.find((f) => f.nodeId === "c")?.status === "error");
	// b settles completed while the run is failing: it drains, records, and its
	// emission would make d fireable (any-of) — the closed gate must hold.
	harness.resolveOneshot(bChild, "<out:Beta>");
	await beat();
	okCheck("failfan: d never started — nothing downstream of the failure runs",
		harness.starts.every((s) => s.label !== "Delta"));
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("failfan: the run finalized error", done.state === "error" && done.pausedAt === undefined);
	okCheck("failfan: the drained sibling kept its completed output",
		done.firings.some((f) => f.nodeId === "b" && f.status === "done" && f.output === "<out:Beta>"));
	okCheck("failfan: the failed firing carries error + stopReason",
		done.firings.some((f) => f.nodeId === "c" && f.status === "error" && f.stopReason === "refusal" && typeof f.settledAt === "string"));
	okCheck("failfan: d has no firing at all", done.firings.every((f) => f.nodeId !== "d"));
	// No commit lands after finalization (the error path uses the same writer).
	const file = join(cwd, ".agent-pipeline", "runs", started.runId + ".json");
	const beforeBytes = await readFile(file, "utf8");
	await beat(); await beat(); await beat();
	okCheck("failfan: no commit landed after finalization (record byte-stable)", beforeBytes === await readFile(file, "utf8"));
});

// --- P6: a sibling failing WHILE parked at a breakpoint — the park unwinds
// without a command, the record leaves `paused` for the drain (no paused
// surface with a disarmed mailbox), and the run finalizes error (the parked
// branch is swept aborted with its output kept, as on abort) ------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				agent("c", "Gamma", "C."),
				agent("e", "Epsilon", "E."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "a", "e")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("failpark: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("b, c, e admitted together", () => harness.starts.length === 4);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	const eChild = harness.starts.find((s) => s.label === "Epsilon")!.childId;
	harness.settle(bChild, "<out:Beta>");
	await waitPausedAt(registry, started.runId, cwd, "b");
	// c fails while the run is parked at b and e is still in flight: the armed
	// control wait must be woken (no hang), the park retired, and the record
	// must leave `paused` for the drain — e's held turn keeps it observable.
	harness.failOneshot(cChild, "boom");
	await waitFor("the record left `paused` for the drain", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return cur.state === "running" && cur.pausedAt === undefined;
	});
	const draining = await registry.getRun(started.runId, cwd) as RunRecord;
	okCheck("failpark: the run is live (running, no pausedAt) while draining", draining.state === "running");
	okCheck("failpark: the drained firing stays parked in the log until finalize",
		draining.firings.find((f) => f.nodeId === "b")?.status === "paused"
		&& draining.firings.find((f) => f.nodeId === "e")?.status === "running");
	// e's paid turn finishes during the drain: completed, output preserved.
	harness.resolveOneshot(eChild, "<out:Epsilon>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("failpark: the failing sibling finalizes the parked run as error", done.state === "error");
	okCheck("failpark: the parked branch is swept aborted with its output kept",
		done.firings.find((f) => f.nodeId === "b")?.status === "aborted"
		&& done.firings.find((f) => f.nodeId === "b")?.output === "<out:Beta>");
	okCheck("failpark: the drained in-flight sibling completed with its output",
		done.firings.find((f) => f.nodeId === "e")?.status === "done" && done.firings.find((f) => f.nodeId === "e")?.output === "<out:Epsilon>");
	okCheck("failpark: the failed sibling carries the error",
		done.firings.find((f) => f.nodeId === "c")?.status === "error" && (done.firings.find((f) => f.nodeId === "c")?.error ?? "").includes("boom"));
	okCheck("failpark: nothing downstream ever started", harness.starts.length === 4);
});

// --- P6: a re-fired crash orphan that fails fails the run — the rebuilt
// parked heads unwind and finalize error (the resurrect path classifies too) --
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const crashed: RunRecord = {
		runId: "failrefire",
		cwd,
		sessionId: "sess",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "paused",
		pausedAt: "f-002",
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				agent("c", "Gamma", "C."),
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "crash",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "done", input: "A.\n\n## Input\ncrash", output: "<out:Alpha>", stopReason: "completed", childSessionId: "oneshot-1", startedAt: "t", settledAt: "t" },
			{ firingId: "f-002", nodeId: "b", seq: 1, status: "paused", input: "B.\n\n## Alpha\n<out:Alpha>", output: "<out:Beta>", stopReason: "completed", childSessionId: "child-9", startedAt: "t" },
			{ firingId: "f-003", nodeId: "c", seq: 1, status: "running", input: "C.\n\n## Alpha\n<out:Alpha>", startedAt: "t" },
		],
		nodes: {},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "failrefire.json"), JSON.stringify(crashed, null, 2));
	await registry.activeRunForCwd(cwd);
	await waitFor("c's orphan re-fired as a held one-shot", () => harness.starts.filter((s) => s.label === "Gamma").length === 1);
	// The re-fired child fails: the run must finalize error — and the parked
	// head b must unwind WITHOUT a control command (no hang).
	harness.failOneshot(harness.starts.find((s) => s.label === "Gamma")!.childId, "boom");
	const done = await waitTerminal(registry, "failrefire", cwd);
	okCheck("failrefire: the failed re-fire finalizes error", done.state === "error");
	okCheck("failrefire: the re-fired firing carries the error",
		done.firings.find((f) => f.nodeId === "c" && f.seq === 2)?.status === "error"
		&& ((done.firings.find((f) => f.nodeId === "c" && f.seq === 2)?.error) ?? "").includes("boom"));
	okCheck("failrefire: the parked head unwound without a command (swept aborted)",
		done.firings.find((f) => f.firingId === "f-002")?.status === "aborted");
	okCheck("failrefire: nothing downstream ran", harness.starts.every((s) => s.label !== "Delta"));
});

// --- P3: any-of never blocks — one firing per arriving message, head consumed
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, target: string, targetPort: string) => ({
		id, source, target, sourcePort: source + ":out", targetPort,
	});
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				agent("b", "Beta", "B."),
				{ ...agent("d", "Delta", "D."), inputPorts: [{ name: "p1", policy: "any-of" }, { name: "p2", policy: "any-of" }] },
			],
			connections: [connP("c1", "a", "d", "d:p1"), connP("c2", "b", "d", "d:p2")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("anyof: start ok", false); return; }
	// Both roots are source-fed and admitted together; neither has settled.
	await waitFor("both roots started", () => harness.starts.length === 2);
	// Alpha settles first: any-of fires d on p1 alone — p2 never blocks it.
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("d fired on the first arrival only", () => harness.starts.length === 3);
	okCheck("anyof: d consumes p1's head, composed from Alpha alone",
		harness.starts[2].prompt === "D.\n\n## Alpha\n<out:Alpha>");
	harness.resolveOneshot(harness.starts[2].childId, "<out:d1>");
	// Beta settles: p2's arrival fires d AGAIN (a node may fire many times).
	harness.resolveOneshot(harness.starts[1].childId, "<out:Beta>");
	await waitFor("d fired again on the second arrival", () => harness.starts.length === 4);
	okCheck("anyof: second firing composed from Beta alone", harness.starts[3].prompt === "D.\n\n## Beta\n<out:Beta>");
	harness.resolveOneshot(harness.starts[3].childId, "<out:d2>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("anyof: run completes with four done firings",
		done.state === "completed" && done.firings.length === 4 && done.firings.every((f) => f.status === "done"));
	okCheck("anyof: d's re-firing continues its per-node seq",
		done.firings[2].nodeId === "d" && done.firings[2].seq === 1 && done.firings[3].nodeId === "d" && done.firings[3].seq === 2);
});

// --- GATE P4: two breakpointed branches admitted concurrently never share a handle
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				{ ...agent("c", "Gamma", "C."), breakpoint: true },
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("anchors2: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	// B and C are admitted together — the batch the shared-coordinator race
	// made reachable — EACH on its own node's parent anchor.
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	const rec = await registry.getRun(started.runId, cwd) as RunRecord;
	const anchorB = rec.nodes.b?.parentAnchorSessionId;
	const anchorC = rec.nodes.c?.parentAnchorSessionId;
	okCheck("anchors2: one anchor per node, distinct ids",
		harness.anchorCreated.length === 2 && typeof anchorB === "string" && typeof anchorC === "string" && anchorB !== anchorC);
	okCheck("anchors2: each child parented to its own node's anchor",
		harness.starts[1].parentId === anchorB && harness.starts[2].parentId === anchorC);
	okCheck("anchors2: both anchors disposed after admission — none live",
		harness.anchorDisposed.length >= 2 && harness.liveAnchors.size === 0);
	okCheck("anchors2: the record carries no shared coordinator field", !("coordinatorSessionId" in rec));
	// Both branches park (the double-breakpoint queue); steer EACH on its own anchor.
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	harness.settle(bChild, "<out:Beta>");
	await waitPausedAt(registry, started.runId, cwd, "b");
	harness.settle(cChild, "<out:Gamma>");
	await waitFor("c parked behind b", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return cur.firings.filter((f) => f.status === "paused").length === 2;
	});
	okCheck("anchors2: no live anchor at either settlement", harness.liveAnchors.size === 0);
	await registry.control(started.runId, { action: "resume" }, cwd); // releases b, surfaces c
	await waitFor("c surfaced as the head", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return cur.pausedAt === cur.firings.find((f) => f.nodeId === "c")?.firingId;
	});
	await registry.control(started.runId, { action: "steer", feedback: "tighten" }, cwd);
	await waitFor("c's followup delivered", () => harness.followups.length === 1);
	okCheck("anchors2: the branch's steer parents to ITS OWN anchor",
		harness.followups[0].childId === cChild && harness.followups[0].parentId === anchorC);
	harness.settle(cChild, "<out:Gamma2>");
	await waitPausedAt(registry, started.runId, cwd, "c");
	await registry.control(started.runId, { action: "resume" }, cwd);
	await waitFor("d started once both branches released", () => harness.starts.length === 4);
	harness.resolveOneshot(harness.starts[3].childId, "<out:Delta>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("anchors2: run completes with four done firings",
		done.state === "completed" && done.firings.length === 4 && done.firings.every((f) => f.status === "done"));
	okCheck("anchors2: d composed both branches' outputs",
		done.firings[3].input === "D.\n\n## Beta\n<out:Beta>\n\n## Gamma\n<out:Gamma2>");
	okCheck("anchors2: no live anchor at the end", harness.liveAnchors.size === 0);
});

// --- P4: a pre-P4 paused record (shared coordinatorSessionId) migrates per node
await withTempDir(async (cwd) => {
	// A record written by the P3 executor: ONE shared coordinator id, an empty
	// nodes map, and a parked child already parented to that shared session.
	const preP4 = {
		runId: "pre-p4",
		cwd,
		sessionId: "sess",
		coordinatorSessionId: "legacy-coord",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "paused",
		pausedAt: "f-002",
		graph: {
			agents: [agent("a", "Alpha", "A."), { ...agent("b", "Beta", "B."), breakpoint: true }, agent("c", "Gamma", "C.")],
			connections: [conn("c1", "a", "b"), conn("c2", "b", "c")],
		},
		input: "x",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "done", input: "a", output: "<out:Alpha>", stopReason: "completed", childSessionId: "oneshot-1", startedAt: "t", settledAt: "t" },
			{ firingId: "f-002", nodeId: "b", seq: 1, status: "paused", input: "b", output: "<out:Beta>", stopReason: "completed", childSessionId: "child-9", startedAt: "t" },
		],
		nodes: {},
	} as unknown as RunRecord;
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "pre-p4.json"), JSON.stringify(preP4, null, 2));
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const discovered = await registry.activeRunForCwd(cwd);
	okCheck("migrate: the pre-P4 paused record resurrects", discovered !== null && discovered.state === "paused");
	// Steering the parked child adopts the legacy coordinator id as b's anchor:
	// the durable address its child already authorizes against.
	await registry.control("pre-p4", { action: "steer", feedback: "after upgrade" }, cwd);
	await waitFor("followup on the legacy address", () => harness.followups.length === 1);
	okCheck("migrate: the legacy id RESUMED — no new anchor session created",
		harness.anchorCreated.length === 0 && harness.anchorResumed.includes("legacy-coord"));
	okCheck("migrate: the followup parents to the legacy anchor id",
		harness.followups[0].childId === "child-9" && harness.followups[0].parentId === "legacy-coord");
	const rec = await registry.getRun("pre-p4", cwd) as RunRecord;
	okCheck("migrate: the record now holds nodes[b].parentAnchorSessionId", rec.nodes.b?.parentAnchorSessionId === "legacy-coord");
	okCheck("migrate: the shared field is retired", !("coordinatorSessionId" in rec));
	harness.settle("child-9", "<out:after-upgrade>");
	await waitPausedAt(registry, "pre-p4", cwd, "b");
	await registry.control("pre-p4", { action: "resume" }, cwd);
	const done = await waitTerminal(registry, "pre-p4", cwd);
	okCheck("migrate: the run completes through the migrated anchor", done.state === "completed" && projectNodes(done).nodes.c.status === "done");
	okCheck("migrate: downstream used the post-upgrade output", harness.starts.find((s) => s.label === "Gamma")?.prompt.includes("<out:after-upgrade>") === true);
});

// --- GATE P5: double-breakpoint queue — two parks, id-order release ----------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				{ ...agent("c", "Gamma", "C."), breakpoint: true },
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("queue: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	// b settles first (parks, halt gate closes); c settles WHILE parked — the
	// second park queues behind it. d must never start from parked branches.
	harness.settle(bChild, "<out:Beta>");
	await waitPausedAt(registry, started.runId, cwd, "b");
	harness.settle(cChild, "<out:Gamma>");
	await waitFor("c parked behind b", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return cur.firings.filter((f) => f.status === "paused").length === 2;
	});
	const parked = await registry.getRun(started.runId, cwd) as RunRecord;
	const firingB = parked.firings.find((f) => f.nodeId === "b")!;
	const firingC = parked.firings.find((f) => f.nodeId === "c")!;
	okCheck("queue: head is b (first settle), c parked behind — firing-id order", parked.pausedAt === firingB.firingId);
	const parkedP = projectNodes(parked);
	okCheck("queue: the projection holds the queue — head first, depth 2",
		parkedP.pausedQueue.length === 2 && parkedP.pausedQueue[0].firingId === firingB.firingId && parkedP.pausedQueue[1].firingId === firingC.firingId);
	okCheck("queue: d never started while parked", harness.starts.every((s) => s.label !== "Delta"));
	// Release the head: the run STAYS parked, the next surfaces.
	await registry.control(started.runId, { action: "resume" }, cwd);
	await waitFor("c surfaced as the head", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return cur.pausedAt === firingC.firingId;
	});
	const afterFirst = await registry.getRun(started.runId, cwd) as RunRecord;
	okCheck("queue: releasing b surfaces c and the run stays paused", afterFirst.state === "paused");
	okCheck("queue: b's released firing is done with its output", firingB !== undefined && afterFirst.firings.find((f) => f.nodeId === "b")?.status === "done");
	okCheck("queue: d still held while c is parked", harness.starts.every((s) => s.label !== "Delta"));
	await registry.control(started.runId, { action: "resume" }, cwd);
	await waitFor("d started once both released", () => harness.starts.length === 4);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("queue: completes with four done firings",
		done.state === "completed" && done.firings.length === 4 && done.firings.every((f) => f.status === "done"));
	okCheck("queue: d composed both released outputs in id order",
		done.firings[3].input === "D.\n\n## Beta\n<out:Beta>\n\n## Gamma\n<out:Gamma>");
});

// --- GATE P5: the pending-pause queue survives a restart — rebuilt from the
// log in firing-id order (the stale pausedAt pointer is not consulted), and
// BOTH parked branches stay steerable across the restart ----------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry1 = new RunRegistry(harness.services);
	const started = await registry1.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				{ ...agent("c", "Gamma", "C."), breakpoint: true },
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("rebuild: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	const admitted = await registry1.getRun(started.runId, cwd) as RunRecord;
	const anchorB = admitted.nodes.b?.parentAnchorSessionId as string;
	const anchorC = admitted.nodes.c?.parentAnchorSessionId as string;
	// Settle OUT of id order: c parks first (the crashed head), then b.
	harness.settle(cChild, "<out:Gamma>");
	await waitPausedAt(registry1, started.runId, cwd, "c");
	harness.settle(bChild, "<out:Beta>");
	await waitFor("b parked behind c", async () => {
		const cur = await registry1.getRun(started.runId, cwd) as RunRecord;
		return cur.firings.filter((f) => f.status === "paused").length === 2;
	});
	const before = await registry1.getRun(started.runId, cwd) as RunRecord;
	const firingB = before.firings.find((f) => f.nodeId === "b")!;
	const firingC = before.firings.find((f) => f.nodeId === "c")!;
	okCheck("rebuild: the crashed head is c (settle order, out of id order)", before.pausedAt === firingC.firingId);
	// "Restart": a brand-new registry over the same workspace.
	const registry2 = new RunRegistry(harness.services);
	const discovered = await registry2.activeRunForCwd(cwd);
	okCheck("rebuild: the paused run resurrects", discovered !== null && discovered.state === "paused");
	// The rebuilt queue re-derives from the LOG in firing-id order: the head
	// flips from the stale c pointer to b.
	await waitFor("the rebuilt head is b", async () => {
		const cur = await registry2.getRun(started.runId, cwd) as RunRecord;
		return cur.pausedAt === firingB.firingId;
	});
	const rebuilt = await registry2.getRun(started.runId, cwd) as RunRecord;
	okCheck("rebuild: both branches parked after the rebuild",
		rebuilt.firings.filter((f) => f.status === "paused").length === 2
		&& projectNodes(rebuilt).pausedQueue.map((f) => f.firingId).join() === firingB.firingId + "," + firingC.firingId);
	// Steer the REBUILT head across the restart: cold-resumed anchor, SAME child.
	await registry2.control(started.runId, { action: "steer", feedback: "tighten beta" }, cwd);
	await waitFor("b's post-restart followup", () => harness.followups.length === 1);
	okCheck("rebuild: steering the rebuilt head hits b's SAME child via its anchor",
		harness.followups[0].childId === bChild && harness.followups[0].parentId === anchorB);
	harness.settle(bChild, "<out:Beta2>");
	await waitPausedAt(registry2, started.runId, cwd, "b");
	// Release b: c surfaces and is steerable too (the SECOND pre-crash branch —
	// P4's "steering both parked branches after a restart" surface).
	await registry2.control(started.runId, { action: "resume" }, cwd);
	await waitFor("c surfaced after the restart release", async () => {
		const cur = await registry2.getRun(started.runId, cwd) as RunRecord;
		return cur.pausedAt === firingC.firingId;
	});
	await registry2.control(started.runId, { action: "steer", feedback: "tighten gamma" }, cwd);
	await waitFor("c's post-restart followup", () => harness.followups.length === 2);
	okCheck("rebuild: the SECOND parked branch steers via its own anchor",
		harness.followups[1].childId === cChild && harness.followups[1].parentId === anchorC);
	harness.settle(cChild, "<out:Gamma2>");
	await waitPausedAt(registry2, started.runId, cwd, "c");
	await registry2.control(started.runId, { action: "resume" }, cwd);
	await waitFor("d started once both rebuilt branches released", () => harness.starts.length === 4);
	const done = await waitTerminal(registry2, started.runId, cwd);
	okCheck("rebuild: completes with four done firings",
		done.state === "completed" && done.firings.length === 4 && done.firings.every((f) => f.status === "done"));
	okCheck("rebuild: d composed both post-restart outputs",
		done.firings[3].input === "D.\n\n## Beta\n<out:Beta2>\n\n## Gamma\n<out:Gamma2>");
});

// --- GATE P5: pause while a branch is in flight — the in-flight output is
// adopted and held; nothing downstream starts until resume ---------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				agent("c", "Gamma", "C."),
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "hello",
	});
	if (!started.ok) { okCheck("inflight: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("b and c admitted together", () => harness.starts.length === 3);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	// b settles and parks WHILE c's paid turn is still in flight.
	harness.settle(bChild, "<out:Beta>");
	const parked = await waitPausedAt(registry, started.runId, cwd, "b");
	const firingB = parked.firings.find((f) => f.nodeId === "b")!;
	okCheck("inflight: parked at b while c is in flight",
		parked.firings.find((f) => f.nodeId === "c")?.status === "running");
	okCheck("inflight: d not started (halt gate closed)", harness.starts.length === 3);
	// c settles while parked: its output is ADOPTED into the log and HELD —
	// the run stays paused, d waits.
	harness.resolveOneshot(cChild, "<out:Gamma>");
	await waitFor("c's in-flight output adopted", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		const c = cur.firings.find((f) => f.nodeId === "c");
		return c?.status === "done" && c.output === "<out:Gamma>";
	});
	const held = await registry.getRun(started.runId, cwd) as RunRecord;
	okCheck("inflight: the run STAYS paused with the adopted output held", held.state === "paused" && held.pausedAt === firingB.firingId);
	okCheck("inflight: d still held after the adopt", harness.starts.length === 3);
	// Resume b: its emission joins c's already-queued message; d composes both.
	await registry.control(started.runId, { action: "resume" }, cwd);
	await waitFor("d started after the resume", () => harness.starts.length === 4);
	harness.resolveOneshot(harness.starts[3].childId, "<out:Delta>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("inflight: completes with d composing both branches",
		done.state === "completed" && done.firings[3].input === "D.\n\n## Beta\n<out:Beta>\n\n## Gamma\n<out:Gamma>");
});

// --- GATE P5: abort mid-fan-out — both continuable children interrupted,
// one-shots cancelled via the run signal, drain before finalize, and no commit
// lands after finalization ------------------------------------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				{ ...agent("c", "Gamma", "C."), breakpoint: true },
				agent("e", "Epsilon", "E."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "a", "e")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("abort-fan: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	// b and c (continuable) and e (held one-shot) admitted together, all in
	// flight when the abort lands.
	await waitFor("b, c, e admitted together", () => harness.starts.length === 4);
	const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
	const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
	const inFlight = await registry.getRun(started.runId, cwd) as RunRecord;
	const anchorB = inFlight.nodes.b?.parentAnchorSessionId as string;
	const anchorC = inFlight.nodes.c?.parentAnchorSessionId as string;
	await registry.control(started.runId, { action: "abort" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("abort-fan: both continuable children interrupted via their node anchors",
		harness.interrupts.some((i) => i.childId === bChild && i.parentSessionId === anchorB)
		&& harness.interrupts.some((i) => i.childId === cChild && i.parentSessionId === anchorC));
	okCheck("abort-fan: the held one-shot was cancelled via the run signal",
		harness.warnings.some((w) => w.includes("agent \"e\" run failed")));
	okCheck("abort-fan: run finalized aborted", done.state === "aborted");
	okCheck("abort-fan: the drain completed first — every firing terminal",
		done.firings.length === 4 && done.firings.every((f) => f.status !== "running" && f.status !== "paused"));
	okCheck("abort-fan: a's completed output preserved", done.firings[0].status === "done" && done.firings[0].output === "<out:Alpha>");
	okCheck("abort-fan: in-flight firings aborted, outputs they had kept",
		done.firings.filter((f) => f.nodeId === "b" || f.nodeId === "c" || f.nodeId === "e").every((f) => f.status === "aborted"));
	// No commit lands after finalization: the record file is byte-stable.
	const file = join(cwd, ".agent-pipeline", "runs", started.runId + ".json");
	const beforeBytes = await readFile(file, "utf8");
	await beat();
	await beat();
	await beat();
	const afterBytes = await readFile(file, "utf8");
	okCheck("abort-fan: no commit landed after finalization (record byte-stable)", beforeBytes === afterBytes);
});

// --- GATE P5 (spec §3 restart): a firing the crash caught IN FLIGHT re-fires
// on resume with its same composed input — exactly Rerun semantics; the dead
// firing is marked aborted and a plain node's re-fired output emits -----------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	// Crashed while b (breakpointed) was parked and c (plain) was in flight.
	const crashed: RunRecord = {
		runId: "refire-plain",
		cwd,
		sessionId: "sess",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "paused",
		pausedAt: "f-002",
		graph: {
			agents: [
				agent("a", "Alpha", "A."),
				{ ...agent("b", "Beta", "B."), breakpoint: true },
				agent("c", "Gamma", "C."),
				agent("d", "Delta", "D."),
			],
			connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
		},
		input: "crash",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "a", seq: 1, status: "done", input: "A.\n\n## Input\ncrash", output: "<out:Alpha>", stopReason: "completed", childSessionId: "oneshot-1", startedAt: "t", settledAt: "t" },
			{ firingId: "f-002", nodeId: "b", seq: 1, status: "paused", input: "B.\n\n## Alpha\n<out:Alpha>", output: "<out:Beta>", stopReason: "completed", childSessionId: "child-9", startedAt: "t" },
			{ firingId: "f-003", nodeId: "c", seq: 1, status: "running", input: "C.\n\n## Alpha\n<out:Alpha>", startedAt: "t" },
		],
		nodes: {},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "refire-plain.json"), JSON.stringify(crashed, null, 2));
	const discovered = await registry.activeRunForCwd(cwd);
	okCheck("refire: the paused record resurrects", discovered !== null && discovered.state === "paused");
	await waitFor("c's orphan re-fired as a one-shot", () => harness.starts.filter((s) => s.label === "Gamma").length === 1);
	const rec = await registry.getRun("refire-plain", cwd) as RunRecord;
	const dead = rec.firings.find((f) => f.firingId === "f-003")!;
	const refire = rec.firings.find((f) => f.nodeId === "c" && f.seq === 2)!;
	okCheck("refire: the dead firing is aborted in the log (honest history)",
		dead.status === "aborted" && typeof dead.settledAt === "string");
	okCheck("refire: a fresh firing re-runs the SAME composed input",
		refire !== undefined && refire.input === dead.input && refire.status === "running" && refire.seq === 2);
	okCheck("refire: the fresh child got the verbatim prompt",
		harness.starts.find((s) => s.label === "Gamma")!.prompt === dead.input);
	// The re-fired output adopts and is HELD while b stays parked.
	harness.resolveOneshot(harness.starts.find((s) => s.label === "Gamma")!.childId, "<out:Gamma2>");
	await waitFor("the re-fired firing adopts its output", async () => {
		const cur = await registry.getRun("refire-plain", cwd) as RunRecord;
		return cur.firings.find((f) => f.nodeId === "c" && f.seq === 2)?.status === "done";
	});
	okCheck("refire: d still gated on the parked branch", harness.starts.every((s) => s.label !== "Delta"));
	await registry.control("refire-plain", { action: "resume" }, cwd);
	await waitFor("d started once the parked branch released", () => harness.starts.some((s) => s.label === "Delta"));
	harness.resolveOneshot(harness.starts.find((s) => s.label === "Delta")!.childId, "<out:Delta>");
	const done = await waitTerminal(registry, "refire-plain", cwd);
	okCheck("refire: the run completes through the re-fired node", done.state === "completed");
	const dFiring = done.firings.find((f) => f.nodeId === "d")!;
	okCheck("refire: d composed the parked branch AND the re-fired branch",
		typeof dFiring.input === "string" && dFiring.input.includes("## Beta\n<out:Beta>") && dFiring.input.includes("## Gamma\n<out:Gamma2>"));
	okCheck("refire: the log reads a done, b done, the dead epoch aborted, the re-fire done, d done",
		done.firings.map((f) => f.firingId + ":" + f.status).join(",") === "f-001:done,f-002:done,f-003:aborted,f-004:done,f-005:done");
});

// --- GATE P5 (spec §3 restart): a crash mid-RERUN — the orphaned continuable
// epoch re-fires, re-parks on its fresh firing, and the stale pausedAt pointer
// is re-derived from the log ---------------------------------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const crashed: RunRecord = {
		runId: "refire-bp",
		cwd,
		sessionId: "sess",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "paused",
		pausedAt: "f-002", // stale: points at the superseded firing, not the orphan
		graph: { agents: [{ ...agent("x", "Xray", "X."), breakpoint: true }], connections: [] },
		input: "x-input",
		recordVersion: 2,
		firings: [
			{ firingId: "f-001", nodeId: "x", seq: 1, status: "paused", input: "X.\n\n## Input\nx-input", output: "<out:old>", stopReason: "completed", childSessionId: "child-7", startedAt: "t" },
			{ firingId: "f-002", nodeId: "x", seq: 2, status: "running", input: "X.\n\n## Input\nx-input", startedAt: "t" },
		],
		nodes: {},
	};
	await mkdir(join(cwd, ".agent-pipeline", "runs"), { recursive: true });
	await writeFile(join(cwd, ".agent-pipeline", "runs", "refire-bp.json"), JSON.stringify(crashed, null, 2));
	await registry.activeRunForCwd(cwd);
	await waitFor("the orphaned rerun epoch re-fired as continuable", () =>
		harness.starts.length === 1 && harness.starts[0].kind === "continuable");
	okCheck("refire-bp: the fresh epoch got the verbatim input", harness.starts[0].prompt === "X.\n\n## Input\nx-input");
	const rec = await registry.getRun("refire-bp", cwd) as RunRecord;
	okCheck("refire-bp: superseded parked firing kept as history, dead epoch aborted",
		rec.firings[0].status === "paused" && rec.firings[1].status === "aborted");
	okCheck("refire-bp: the node's anchor was created for the re-fire", typeof rec.nodes.x?.parentAnchorSessionId === "string");
	const childId = harness.starts[0].childId;
	harness.settle(childId, "<out:rerun2>");
	const parked = await waitPausedAt(registry, "refire-bp", cwd, "x");
	const fresh = parked.firings.find((f) => f.seq === 3)!;
	okCheck("refire-bp: re-parked on the fresh (seq 3) firing; the stale pointer was re-derived",
		parked.pausedAt === fresh.firingId && fresh.status === "paused" && fresh.output === "<out:rerun2>" && fresh.childSessionId === childId);
	await registry.control("refire-bp", { action: "resume" }, cwd);
	const done = await waitTerminal(registry, "refire-bp", cwd);
	okCheck("refire-bp: completes with the re-fired output; the old parked firing stays history",
		done.state === "completed" && done.firings.find((f) => f.seq === 3)?.status === "done"
		&& done.firings.find((f) => f.seq === 1)?.status === "paused" && done.firings.find((f) => f.seq === 2)?.status === "aborted");
});

// --- GATE P7: selective emission (conditional-dispatch.md) — the analyze node
// routes on its structured result: the unselected branch never fires, the
// catch-all catches the no-match case, the any-of join fires on whichever
// branch ran, and emittedTo records the port selection -------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				{
					...agent("n", "Analyze", "Decide the channel."),
					outputPorts: ["mail", "slack"],
					bindings: [
						{ field: "action", value: "mail", port: "mail" },
						{ field: "action", value: "slack", port: "slack" },
					],
					settings: { outputSchema: { type: "object" } },
				},
				agent("m", "Mail", "M."),
				agent("s", "Slack", "S."),
				{ ...agent("j", "Join", "J."), inputPorts: [{ name: "p1", policy: "any-of" }, { name: "p2", policy: "any-of" }] },
			],
			connections: [connP("c1", "n", "n:mail", "m", "m:in"), connP("c2", "n", "n:slack", "s", "s:in"), connP("c3", "m", "m:out", "j", "j:p1"), connP("c4", "s", "s:out", "j", "j:p2")],
		},
		input: "doc",
	});
	if (!started.ok) { okCheck("emit: start ok", false); return; }
	await waitFor("n started", () => harness.starts.length === 1);
	// The structured result selects the mail port; the slack branch never starts.
	harness.resolveOneshot(harness.starts[0].childId, "<out:n>", "completed", { action: "mail" });
	await waitFor("m started on the mail branch", () => harness.starts.length === 2);
	okCheck("emit: only the selected branch starts (no model call on slack)", harness.starts[1].label === "Mail");
	const mid = await registry.getRun(started.runId, cwd) as RunRecord;
	okCheck("emit: the firing recorded emittedTo [mail]", mid.firings[0].emittedTo?.join() === "mail");
	harness.resolveOneshot(harness.starts[1].childId, "<out:mail>");
	await waitFor("the any-of join fired on the branch that ran", () => harness.starts.length === 3);
	okCheck("emit: the join composed from the mail branch alone", harness.starts[2].prompt === "J.\n\n## Mail\n<out:mail>");
	harness.resolveOneshot(harness.starts[2].childId, "<out:joined>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("emit: completes with three done firings (slack has none)",
		done.state === "completed" && done.firings.length === 3 && done.firings.every((f) => f.status === "done")
		&& done.firings.every((f) => f.nodeId !== "s"));
	okCheck("emit: the quiet slack branch surfaces in the run report",
		harness.warnings.some((w) => w.includes("waiting nodes: s")));
});

// --- GATE P7: the catch-all binding catches the no-match case -----------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				{
					...agent("n", "Analyze", "Decide."),
					outputPorts: ["mail", "other"],
					bindings: [{ field: "action", value: "mail", port: "mail" }, { field: "action", port: "other" }],
					settings: { outputSchema: { type: "object" } },
				},
				agent("m", "Mail", "M."),
				agent("o", "Other", "O."),
			],
			connections: [connP("c1", "n", "n:mail", "m", "m:in"), connP("c2", "n", "n:other", "o", "o:in")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("catchall: start ok", false); return; }
	await waitFor("n started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:n>", "completed", { action: "archive" });
	await waitFor("the catch-all branch started", () => harness.starts.length === 2);
	okCheck("catchall: the no-match result fell to the catch-all port", harness.starts[1].label === "Other");
	harness.resolveOneshot(harness.starts[1].childId, "<out:other>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("catchall: completes with the catch-all branch done, mail quiet",
		done.state === "completed" && done.firings.length === 2
		&& done.firings[0].emittedTo?.join() === "other" && done.firings.every((f) => f.nodeId !== "m"));
});

// --- GATE P7: bindings without a structured result emit on no port — the
// honest quiet: nothing downstream starts, the starvation report names it ------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				{
					...agent("n", "Analyze", "Decide."),
					outputPorts: ["mail", "slack"],
					bindings: [{ field: "action", value: "mail", port: "mail" }],
					// No outputSchema: the one-shot child returns plain text —
					// nothing for the bindings to evaluate against.
				},
				agent("m", "Mail", "M."),
			],
			connections: [connP("c1", "n", "n:mail", "m", "m:in")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("quiet: start ok", false); return; }
	await waitFor("n started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:n>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("quiet: the run completes with n done and m never started",
		done.state === "completed" && done.firings.length === 1 && done.firings[0].status === "done"
		&& harness.starts.length === 1);
	okCheck("quiet: the empty selection is recorded on the firing", done.firings[0].emittedTo?.length === 0);
	okCheck("quiet: the starved downstream node is reported", harness.warnings.some((w) => w.includes("waiting nodes: m")));
});

// --- GATE P7: the feedback/verdict loop — emitting feedback continues the
// loop, emitting only the verdict ends it (quiescence); the loop composes for
// free (conditional-dispatch §3). The cycle is seeded by the task root (the
// source feeds edge-less nodes only), whose message enters the coder's any-of
// port; the feedback re-feeds the same port — one firing per arrival. --------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("k", "Task", "Task."),
				{ ...agent("c", "Coder", "Code."), inputPorts: [{ name: "in", policy: "any-of" }] },
				{
					...agent("r", "Review", "Review."),
					outputPorts: ["feedback", "verdict"],
					bindings: [
						{ field: "decision", value: "feedback", port: "feedback" },
						{ field: "decision", value: "verdict", port: "verdict" },
					],
					settings: { outputSchema: { type: "object" } },
				},
				agent("t", "Terminal", "T."),
			],
			connections: [connP("c0", "k", "k:out", "c", "c:in"), connP("c1", "c", "c:out", "r", "r:in"), connP("c2", "r", "r:feedback", "c", "c:in"), connP("c3", "r", "r:verdict", "t", "t:in")],
		},
		input: "build",
	});
	if (!started.ok) { okCheck("loop: start ok", false); return; }
	// The task root seeds the cycle; the coder composes round 1 from it alone.
	await waitFor("task started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<task:1>");
	await waitFor("coder round 1", () => harness.starts.length === 2);
	okCheck("loop: the coder fired from the task seed", harness.starts[1].prompt === "Code.\n\n## Task\n<task:1>");
	harness.resolveOneshot(harness.starts[1].childId, "<code:1>");
	await waitFor("review round 1", () => harness.starts.length === 3);
	// Feedback: the loop continues — the coder re-fires on the feedback arrival.
	// The review's STRUCTURED result is what flows downstream, rendered as JSON
	// (the one-shot adoption prefers it over the raw text).
	harness.resolveOneshot(harness.starts[2].childId, "<review:1>", "completed", { decision: "feedback" });
	await waitFor("coder round 2 (the feedback re-fed the coder)", () => harness.starts.length === 4);
	okCheck("loop: the coder re-fired from the feedback port on the rendered structured result",
		harness.starts[3].prompt === "Code.\n\n## Review\n" + JSON.stringify({ decision: "feedback" }, null, 2));
	harness.resolveOneshot(harness.starts[3].childId, "<code:2>");
	await waitFor("review round 2", () => harness.starts.length === 5);
	// Verdict: the feedback port goes quiet and the loop ends.
	harness.resolveOneshot(harness.starts[4].childId, "<review:2>", "completed", { decision: "verdict" });
	await waitFor("the terminal started on the verdict branch", () => harness.starts.length === 6);
	okCheck("loop: the verdict branch fed the terminal", harness.starts[5].label === "Terminal");
	harness.resolveOneshot(harness.starts[5].childId, "<final>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("loop: run completed at quiescence with coder×2, review×2, terminal×1",
		done.state === "completed" && done.firings.length === 6
		&& done.firings.filter((f) => f.nodeId === "c").map((f) => f.seq).join() === "1,2"
		&& done.firings.filter((f) => f.nodeId === "r").length === 2
		&& done.firings.filter((f) => f.nodeId === "t").length === 1);
	okCheck("loop: the verdict firing recorded emittedTo [verdict]",
		done.firings.find((f) => f.nodeId === "r" && f.seq === 2)?.emittedTo?.join() === "verdict");
});

// --- GATE P7: the loop BUDGET — the feedback entry's delivery bound caps the
// iterations: the overflowing message is dropped + recorded (design principle
// 4), nothing downstream of the drop fires, and the run still ends cleanly ----
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				agent("k", "Task", "Task."),
				// bound 2: the task seed + ONE feedback round; the second
				// feedback delivery overflows and is dropped.
				{ ...agent("c", "Coder", "Code."), inputPorts: [{ name: "in", policy: "any-of", bound: 2 }] },
				{
					...agent("r", "Review", "Review."),
					outputPorts: ["feedback", "verdict"],
					bindings: [{ field: "decision", value: "feedback", port: "feedback" }, { field: "decision", value: "verdict", port: "verdict" }],
					settings: { outputSchema: { type: "object" } },
				},
				agent("t", "Terminal", "T."),
			],
			connections: [connP("c0", "k", "k:out", "c", "c:in"), connP("c1", "c", "c:out", "r", "r:in"), connP("c2", "r", "r:feedback", "c", "c:in"), connP("c3", "r", "r:verdict", "t", "t:in")],
		},
		input: "build",
	});
	if (!started.ok) { okCheck("budget: start ok", false); return; }
	await waitFor("task started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<task:1>");
	await waitFor("coder round 1", () => harness.starts.length === 2);
	harness.resolveOneshot(harness.starts[1].childId, "<code:1>");
	await waitFor("review round 1", () => harness.starts.length === 3);
	harness.resolveOneshot(harness.starts[2].childId, "<review:1>", "completed", { decision: "feedback" });
	await waitFor("coder round 2", () => harness.starts.length === 4);
	harness.resolveOneshot(harness.starts[3].childId, "<code:2>");
	await waitFor("review round 2", () => harness.starts.length === 5);
	// The second feedback overflows the coder's bound (seed + 1 accepted).
	harness.resolveOneshot(harness.starts[4].childId, "<review:2>", "completed", { decision: "feedback" });
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("budget: the run ends completed at the bound (a dropped loop message is not a failure)",
		done.state === "completed");
	okCheck("budget: the overflow is recorded against the port",
		JSON.stringify(done.dropped) === JSON.stringify([{ nodeId: "c", port: "in", from: "r" }]));
	okCheck("budget: the coder fired exactly twice; the terminal never fired",
		done.firings.filter((f) => f.nodeId === "c").length === 2
		&& done.firings.every((f) => f.nodeId !== "t") && harness.starts.length === 5);
	okCheck("budget: the overflowing firing still recorded its port selection",
		done.firings.find((f) => f.nodeId === "r" && f.seq === 2)?.emittedTo?.join() === "feedback");
});

// --- P7: a multi-port node WITHOUT bindings still emits everywhere (the P3
// default); declared output ports do not change an unbound node's behavior ----
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				{ ...agent("n", "Broad", "B."), outputPorts: ["a", "b"] },
				agent("x", "X", "X."),
				agent("y", "Y", "Y."),
			],
			connections: [connP("c1", "n", "n:a", "x", "x:in"), connP("c2", "n", "n:b", "y", "y:in")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("allports: start ok", false); return; }
	await waitFor("n started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:n>");
	await waitFor("both branches started", () => harness.starts.length === 3);
	harness.resolveOneshot(harness.starts[1].childId, "<out:x>");
	harness.resolveOneshot(harness.starts[2].childId, "<out:y>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("allports: an unbound node emits on every declared port",
		done.state === "completed" && done.firings.length === 3
		&& done.firings[0].emittedTo?.join() === "a,b"
		&& done.firings.every((f) => f.status === "done"));
});

// --- GATE P8 (spec §8 starvation, minimal and dedicated): an all-of port that
// is never filled goes QUIET at quiescence — the run completes, the waiting
// node is named in the report, and it never fired ------------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const connP = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [
				{
					...agent("s", "Source", "S."),
					outputPorts: ["used", "unused"],
					bindings: [{ field: "k", value: "v", port: "used" }],
					settings: { outputSchema: { type: "object" } },
				},
				agent("w", "Waiter", "W."),
			],
			// w's (default, all-of) port is wired to the port the binding will
			// NOT select — the only source that could ever fill it.
			connections: [connP("c1", "s", "s:unused", "w", "w:in")],
		},
		input: "x",
	});
	if (!started.ok) { okCheck("starve: start ok", false); return; }
	await waitFor("s started", () => harness.starts.length === 1);
	// The structured result selects "used", whose port has no edges: nothing
	// ever arrives at w's all-of port, and no other message can.
	harness.resolveOneshot(harness.starts[0].childId, "<out:s>", "completed", { k: "v" });
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("starve: the run goes quiet completed (a starved port is not a failure)", done.state === "completed");
	okCheck("starve: only s fired; w never started",
		done.firings.length === 1 && done.firings[0].nodeId === "s" && harness.starts.length === 1);
	okCheck("starve: the report names the waiting node w",
		harness.warnings.some((w) => w.includes("waiting nodes: w")));
});

// --- GATE P8 (spec §8 commit writer): isolation over an OBSERVED write log —
// snapshots of the record file sampled DURING concurrent commits (a settle
// burst racing the abort drain) are always whole records with gap-free firing
// ids, their firing counts never regress (a stale snapshot never overwrote a
// newer one), and no commit lands after finalization ----------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const branches = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id, i) => agent(id, "Br" + (i + 1), id + "."));
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [agent("a", "Alpha", "A."), ...branches],
			connections: branches.map((b) => conn("cc-" + b.id, "a", b.id)),
		},
		input: "x",
		maxInFlight: 7, // never binds: every branch in flight at once
	});
	if (!started.ok) { okCheck("commits: start ok", false); return; }
	const file = join(cwd, ".agent-pipeline", "runs", started.runId + ".json");
	// The write log: every whole-file snapshot the sampler catches while the
	// executor commits concurrently. An open error (a rename in flight) skips
	// a sample; a TORN or interleaved snapshot fails to parse below.
	const snapshots: string[] = [];
	let watching = true;
	const watcher = (async () => {
		while (watching) {
			try { snapshots.push(await readFile(file, "utf8")); } catch { /* between commits */ }
			await new Promise((resolve) => { setTimeout(resolve, 2); });
		}
	})();
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("all six branches in flight", () => harness.starts.length === 7);
	// Three settles land back-to-back and are given a beat to COMMIT (their
	// settle/emission commits race the chain) — then the abort drains the
	// three still-held one-shots and sweeps them in the finalize commit.
	for (const start of harness.starts.slice(1, 4)) harness.resolveOneshot(start.childId, "<out:" + start.label + ">");
	await waitFor("the three settles committed", async () => {
		const cur = await registry.getRun(started.runId, cwd) as RunRecord;
		return ["b1", "b2", "b3"].every((id) => cur.firings.find((f) => f.nodeId === id)?.status === "done");
	});
	await registry.control(started.runId, { action: "abort" }, cwd);
	const done = await waitTerminal(registry, started.runId, cwd);
	watching = false;
	await watcher;
	okCheck("commits: the run finalized aborted with the settled outputs kept",
		done.state === "aborted"
		&& ["a", "b1", "b2", "b3"].every((id) => done.firings.find((f) => f.nodeId === id)?.status === "done")
		&& ["b4", "b5", "b6"].every((id) => done.firings.find((f) => f.nodeId === id)?.status === "aborted"));
	let whole = true;
	let monotonic = true;
	let sawMidRun = false;
	let previousCount = -1;
	for (const text of snapshots) {
		let rec: RunRecord;
		try { rec = JSON.parse(text) as RunRecord; } catch { whole = false; break; }
		if (rec.recordVersion !== 2 || (rec.state !== "running" && rec.state !== "aborted" && rec.state !== "completed")) { whole = false; break; }
		const ids = rec.firings.map((f) => f.firingId).join();
		const expected = Array.from({ length: rec.firings.length }, (_, i) => "f-" + String(i + 1).padStart(3, "0")).join();
		if (ids !== expected) { whole = false; break; }
		if (rec.state === "running" && rec.firings.length < 7) sawMidRun = true;
		if (rec.firings.length < previousCount) monotonic = false;
		previousCount = rec.firings.length;
	}
	okCheck("commits: the write log rode the run (mid-run snapshots observed)", snapshots.length >= 3 && sawMidRun);
	okCheck("commits: every observed snapshot is a whole record (never torn, never interleaved)", whole);
	okCheck("commits: firing counts never regress across the log (no stale snapshot overwrote a newer one)", monotonic);
	// No late writes: the terminal bytes are final.
	const finalBytes = await readFile(file, "utf8");
	await beat();
	await beat();
	await beat();
	okCheck("commits: no commit landed after finalization (record byte-stable)", finalBytes === await readFile(file, "utf8"));
});

// --- GATE P8 (spec §8 determinism): the same scripted run twice yields an
// IDENTICAL firing structure — ids, log order (= the id-ordered ready order),
// statuses, composed inputs/outputs, emissions, child ids — modulo the
// wall-clock timestamps and the environment-minted run id -----------------------
async function scriptedFanRun(): Promise<string> {
	// withTempDir's callback returns void — the structure rides out through
	// this variable.
	let structure = "";
	await withTempDir(async (cwd) => {
		const harness = makeHarness({ holdOneshots: true });
		const registry = new RunRegistry(harness.services);
		const started = await registry.startRun({
			sessionId: "sess",
			cwd,
			graph: {
				agents: [agent("a", "Alpha", "A."), agent("b", "Beta", "B."), agent("c", "Gamma", "C."), agent("d", "Delta", "D.")],
				connections: [conn("c1", "a", "b"), conn("c2", "a", "c"), conn("c3", "b", "d"), conn("c4", "c", "d")],
			},
			input: "hello",
		});
		if (!started.ok) throw new Error("determinism: start failed");
		await waitFor("a started", () => harness.starts.length === 1);
		harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
		await waitFor("b and c admitted together", () => harness.starts.length === 3);
		const bChild = harness.starts.find((s) => s.label === "Beta")!.childId;
		const cChild = harness.starts.find((s) => s.label === "Gamma")!.childId;
		harness.resolveOneshot(cChild, "<out:Gamma>"); // the slower branch settles first — same script both runs
		harness.resolveOneshot(bChild, "<out:Beta>");
		await waitFor("d started", () => harness.starts.length === 4);
		harness.resolveOneshot(harness.starts[3].childId, "<out:Delta>");
		const done = await waitTerminal(registry, started.runId, cwd);
		if (done.state !== "completed") throw new Error("determinism: run did not complete");
		// The comparable structure: everything but wall-clock timestamps and
		// the environment-minted run id (this graph mints no anchor ids).
		structure = JSON.stringify(done.firings.map((f) => ({
			firingId: f.firingId, nodeId: f.nodeId, seq: f.seq, status: f.status,
			input: f.input, output: f.output, stopReason: f.stopReason,
			childSessionId: f.childSessionId, emittedTo: f.emittedTo,
		})));
	});
	return structure;
}
{
	const detFirst = await scriptedFanRun();
	const detSecond = await scriptedFanRun();
	okCheck("determinism: two identical scripted runs produce identical firing structures", detFirst === detSecond);
	const detParsed = JSON.parse(detFirst) as Array<{ firingId: string; nodeId: string; seq: number; status: string }>;
	okCheck("determinism: the shared structure is the pinned fan-out shape — f-001..f-004, b before c (ready order by id), d last",
		detParsed.map((f) => f.firingId).join() === "f-001,f-002,f-003,f-004"
		&& detParsed.map((f) => f.nodeId).join() === "a,b,c,d"
		&& detParsed.every((f) => f.seq === 1) && detParsed.every((f) => f.status === "done"));
}

// --- GATE P8 (spec §1): the DEFAULT maxInFlight is 4 — a wide fan-out without
// a cap field admits exactly four branches before the first settle, in id
// order, and freed slots go to the next id --------------------------------------
await withTempDir(async (cwd) => {
	const harness = makeHarness({ holdOneshots: true });
	const registry = new RunRegistry(harness.services);
	const wide = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id, i) => agent(id, "W" + (i + 1), id + "."));
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: {
			agents: [agent("a", "Alpha", "A."), ...wide],
			connections: wide.map((w) => conn("wc-" + w.id, "a", w.id)),
		},
		input: "fan",
		// no maxInFlight: the default (4) governs
	});
	if (!started.ok) { okCheck("default-cap: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:Alpha>");
	await waitFor("four branches admitted", () => harness.starts.length === 5);
	await beat();
	okCheck("default-cap: exactly four branches admitted, in id order",
		harness.starts.length === 5 && harness.starts.slice(1).map((s) => s.label).join(",") === "W1,W2,W3,W4");
	const childOf = (label: string) => harness.starts.find((s) => s.label === label)!.childId;
	harness.resolveOneshot(childOf("W1"), "<out:w1>");
	await waitFor("the fifth branch admitted after a slot freed", () => harness.starts.length === 6);
	okCheck("default-cap: the freed slot goes to the next id", harness.starts[5].label === "W5");
	harness.resolveOneshot(childOf("W2"), "<out:w2>");
	await waitFor("the sixth branch admitted", () => harness.starts.length === 7);
	okCheck("default-cap: the last branch is W6", harness.starts[6].label === "W6");
	harness.resolveOneshot(childOf("W3"), "<out:w3>");
	harness.resolveOneshot(childOf("W4"), "<out:w4>");
	harness.resolveOneshot(childOf("W5"), "<out:w5>");
	harness.resolveOneshot(childOf("W6"), "<out:w6>");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("default-cap: completes with all seven firings done",
		done.state === "completed" && done.firings.length === 7 && done.firings.every((f) => f.status === "done"));
	okCheck("default-cap: the record carries the resolved default", done.maxInFlight === 4);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
