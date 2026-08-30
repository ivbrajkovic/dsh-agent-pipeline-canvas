// Durable run registry tests — plain Node script (no framework). Run:
//   tsx test/runs.test.ts
// Exercises the executor and control plane against SCRIPTED services (the same
// fake-service style as runner.test.ts): a fake subagent seam whose continuable
// children settle when the test emits a `subagent/end` payload and whose
// ONE-SHOT children settle on demand (holdOneshots + resolveOneshot — the
// marble harness scripts one-shot interleavings too), a fake agents service
// that records coordinator create/resume/dispose, and a real temp directory
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
// path — all WITHOUT a live model.
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
	resolve: (result: { output: Array<{ type: string; text: string }>; stopReason: string }) => void;
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
	const coordinatorCreated: Array<{ sessionId: string; meta: Record<string, unknown> | undefined; agentOptions: Record<string, unknown> | undefined }> = [];
	const coordinatorResumed: string[] = [];
	const coordinatorDisposed: string[] = [];
	const liveCoordinators = new Set<string>();
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
			if (liveCoordinators.has(id)) return { id, options: {} };
			return undefined;
		},
		create: async (opts: { sessionId: string; meta?: Record<string, unknown>; agentOptions?: Record<string, unknown> }) => {
			coordinatorCreated.push({ sessionId: opts.sessionId, meta: opts.meta, agentOptions: opts.agentOptions });
			liveCoordinators.add(opts.sessionId);
			return {
				agent: { id: opts.sessionId, options: {} },
				dispose: async () => { liveCoordinators.delete(opts.sessionId); coordinatorDisposed.push(opts.sessionId); },
			};
		},
		resume: async (opts: { resumeSessionId: string }) => {
			coordinatorResumed.push(opts.resumeSessionId);
			liveCoordinators.add(opts.resumeSessionId);
			return {
				agent: { id: opts.resumeSessionId, options: {} },
				dispose: async () => { liveCoordinators.delete(opts.resumeSessionId); coordinatorDisposed.push(opts.resumeSessionId); },
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
		coordinatorCreated, coordinatorResumed, coordinatorDisposed, liveCoordinators,
		warnings,
		/** Simulate the child's epoch settling: the harness emits `subagent/end`. */
		settle(childId: string, output: string, stopReason = "completed") {
			const info = { runId: "run-" + childId, provider: "spawn", id: childId, local: true, stopReason, lastAssistantMessage: [{ type: "text", text: output }] };
			for (const listener of [...listeners]) listener(info);
		},
		/** Settle a HELD one-shot child (holdOneshots) with a successful result. */
		resolveOneshot(childId: string, output: string, stopReason = "completed") {
			const deferred = heldOneshots.get(childId);
			if (deferred === undefined) throw new Error("no held one-shot child \"" + childId + "\"");
			heldOneshots.delete(childId);
			deferred.resolve({ output: [{ type: "text", text: output }], stopReason });
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
	// The continuable child parents to the run coordinator; the one-shot
	// child stays parented to the session agent (unchanged behavior).
	const coordinatorId = rec.coordinatorSessionId as string;
	okCheck("pause: continuable child parented to the coordinator", harness.starts[0].parentId === coordinatorId);
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
	okCheck("rerun: steer parented to the coordinator", harness.followups[0].parentId === first.coordinatorSessionId);
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

// --- coordinator lifecycle: created with depth 0, disposed between ops ------
await withTempDir(async (cwd) => {
	const harness = makeHarness();
	const registry = new RunRegistry(harness.services);
	const started = await registry.startRun({
		sessionId: "sess",
		cwd,
		graph: { agents: [{ ...agent("a", "Alpha", "A."), breakpoint: true }], connections: [] },
		input: "x",
	});
	if (!started.ok) { okCheck("coordinator: start ok", false); return; }
	await waitFor("a's continuable start", () => harness.starts.length === 1);
	harness.settle(harness.starts[0].childId, "<out:1>");
	const rec = await waitPausedAt(registry, started.runId, cwd, "a");
	okCheck("coordinator: exactly one created", harness.coordinatorCreated.length === 1);
	const created = harness.coordinatorCreated[0];
	okCheck("coordinator: persisted in the record", rec.coordinatorSessionId === created.sessionId);
	okCheck("coordinator: meta origin/depth/parent", created.meta?.origin === "subagent" && created.meta?.delegationDepth === 0 && created.meta?.parentSession === "sess" && created.meta?.cwd === cwd);
	okCheck("coordinator: options mirrored minus subagentDepth", created.agentOptions?.provider === "ds" && created.agentOptions?.subagentDepth === undefined);
	okCheck("coordinator: disposed after the start acceptance", harness.coordinatorDisposed.includes(created.sessionId) && !harness.liveCoordinators.has(created.sessionId));
	// Steer: resumed on demand, disposed again right after the followup.
	await registry.control(started.runId, { action: "steer", feedback: "go on" }, cwd);
	await waitFor("followup", () => harness.followups.length === 1);
	okCheck("coordinator: resumed for the steer", harness.coordinatorResumed.includes(created.sessionId));
	await waitFor("coordinator re-disposed", () => harness.coordinatorDisposed.filter((id) => id === created.sessionId).length >= 2);
	okCheck("coordinator: absent parent drops the settlement notice (no live coordinator)", !harness.liveCoordinators.has(created.sessionId));
	harness.settle(projectNodes(rec).nodes.a.childSessionId as string, "<out:yes>");
	await waitPausedAt(registry, started.runId, cwd, "a");
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
	okCheck("abort-flight: interrupt sent to the live child via the coordinator address",
		harness.interrupts.some((i) => i.childId === bChild && i.parentSessionId === rec.coordinatorSessionId));
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
	const coordinatorId = before.coordinatorSessionId as string;
	// "Restart": a brand-new registry over the same workspace.
	const registry2 = new RunRegistry(harness.services);
	const discovered = await registry2.activeRunForCwd(cwd);
	const discoveredP = discovered !== null ? projectNodes(discovered) : null;
	okCheck("restart: paused run discovered via the workspace",
		discovered !== null && discovered.runId === started.runId && discovered.state === "paused" && discoveredP?.pausedNodeId === "a");
	okCheck("restart: coordinator id preserved", discovered?.coordinatorSessionId === coordinatorId);
	// Steering after the restart: coordinator resumed, SAME child, then resume.
	await registry2.control(started.runId, { action: "steer", feedback: "post-restart steer" }, cwd);
	await waitFor("post-restart followup", () => harness.followups.length === 1);
	okCheck("restart: followup to the SAME child", harness.followups[0].childId === childId);
	okCheck("restart: coordinator cold-resumed for the steer", harness.coordinatorResumed.includes(coordinatorId));
	okCheck("restart: steer parented to the resumed coordinator", harness.followups[0].parentId === coordinatorId);
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
	okCheck("degraded: no coordinator ever created", harness.coordinatorCreated.length === 0);
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

// --- GATE P3: quiescence with an unfilled all-of port reports the waiting node
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
	if (!started.ok) { okCheck("starve: start ok", false); return; }
	await waitFor("a started", () => harness.starts.length === 1);
	harness.resolveOneshot(harness.starts[0].childId, "<out:A>");
	await waitFor("f started", () => harness.starts.length === 2);
	// f fails: it records the error and emits nothing, so d's p2 never fills.
	harness.failOneshot(harness.starts[1].childId, "boom");
	const done = await waitTerminal(registry, started.runId, cwd);
	okCheck("starve: the run ends at quiescence, completed", done.state === "completed");
	okCheck("starve: d never fires with its all-of port unfilled", done.firings.every((f) => f.nodeId !== "d"));
	okCheck("starve: the failed firing is recorded with its error (P3: not gating)",
		done.firings.some((f) => f.nodeId === "f" && f.status === "error" && (f.error ?? "").includes("boom")));
	okCheck("starve: the completed upstream is preserved",
		done.firings.some((f) => f.nodeId === "a" && f.status === "done" && f.output === "<out:A>"));
	okCheck("starve: the waiting node is reported",
		harness.warnings.some((w) => w.includes("waiting nodes: d")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
