// canvas-graph.test.ts — the canvas state ⇄ persisted-graph boundary for the
// if control. Plain Node script (no framework). Run with:
//   tsx test/canvas-graph.test.ts
// buildGraph/loadControls live in src/ui/shared.ts — the browser-side
// serializer, which the node build does not emit (tsdown inlines it into
// lib/client.js), so they are imported from source through tsx's transpile.
// validateGraph/lowerControls come from lib/ like every other suite: the same
// implementations the Host and the browser bundle run. Covers the C2 gate:
// the buildGraph/load round-trip with controls (control-targeted edges carry
// no targetPort, control-sourced edges always name the branch, the ""-value
// catch-all drops its key), legacy graphs serializing byte-identically
// without a `controls` key, and the canvas-authored Billing/General sample
// validating and serializing to exactly its hand-authored ports+bindings twin.
import { buildGraph, loadControls, type CanvasAgent, type CanvasConnection, type CanvasControl } from "../src/ui/shared.ts";
import { cycleClosingFlip, validateGraph } from "../lib/graph.js";
import { lowerControls } from "../lib/controls.js";
import { deepStrictEqual, ok } from "node:assert";

let passed = 0;
let failed = 0;

function attempt(name: string, run: () => void) {
	try {
		run();
		passed++;
		console.log(`ok    ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL  ${name}`);
		console.error(`      ${error instanceof Error ? error.message : String(error)}`);
	}
}

// The Billing/General router sample as the canvas holds it after the C2 E2E
// authoring flow: three agents, an if with a valued branch plus the catch-all,
// and the honest wiring (the control's single unnamed input, one edge per
// branch tick).
const ifAgents: CanvasAgent[] = [
	{ id: "agent-1", name: "Router", description: "", instructions: "", x: 40, y: 60, settings: { outputSchema: { type: "object" } } },
	{ id: "agent-2", name: "Billing", description: "", instructions: "", x: 260, y: 20 },
	{ id: "agent-3", name: "General", description: "", instructions: "", x: 260, y: 120 },
];
const ifConnections: CanvasConnection[] = [
	{ id: "conn-1", source: "agent-1", target: "if-1" },
	{ id: "conn-2", source: "if-1", target: "agent-2", sourcePort: "billing" },
	{ id: "conn-3", source: "if-1", target: "agent-3", sourcePort: "other" },
];
const ifControls: CanvasControl[] = [
	{ id: "if-1", kind: "if", x: 150, y: 70, branches: [
		{ name: "billing", field: "action", value: "billing", side: "top" },
		{ name: "other", field: "action" },
	] },
];
// The same pipeline authored the pre-control way: ports + bindings on the
// Router, the fork invisible.
const twinAgents: CanvasAgent[] = [
	{
		id: "agent-1", name: "Router", description: "", instructions: "", x: 40, y: 60,
		settings: { outputSchema: { type: "object" } },
		outputPorts: ["billing", "other"],
		outputPortSides: { billing: "top" },
		bindings: [
			{ field: "action", value: "billing", port: "billing" },
			{ field: "action", port: "other" },
		],
	},
	{ id: "agent-2", name: "Billing", description: "", instructions: "", x: 260, y: 20 },
	{ id: "agent-3", name: "General", description: "", instructions: "", x: 260, y: 120 },
];
const twinConnections: CanvasConnection[] = [
	{ id: "conn-2", source: "agent-1", target: "agent-2", sourcePort: "billing" },
	{ id: "conn-3", source: "agent-1", target: "agent-3", sourcePort: "other" },
];

attempt("a graph without controls serializes exactly as before (no controls key)", () => {
	deepStrictEqual(
		buildGraph(
			[{ id: "agent-1", name: "Agent 1", description: "", instructions: "", x: 10, y: 20 }],
			[{ id: "conn-1", source: "agent-1", target: "agent-2" }],
		),
		{
			agents: [{ id: "agent-1", name: "Agent 1", description: "", instructions: "", x: 10, y: 20, input: "agent-1:in", output: "agent-1:out" }],
			connections: [{ id: "conn-1", source: "agent-1", target: "agent-2", sourcePort: "agent-1:out", targetPort: "agent-2:in" }],
		},
	);
});

attempt("an empty controls list still omits the key", () => {
	const built = buildGraph(ifAgents.slice(0, 1), [], []);
	ok(!("controls" in built));
});

attempt("control endpoints serialize by the control rules", () => {
	const built = buildGraph(ifAgents, ifConnections, ifControls);
	deepStrictEqual(built.connections, [
		// The control's single input: no targetPort key.
		{ id: "conn-1", source: "agent-1", target: "if-1", sourcePort: "agent-1:out" },
		// Control-sourced edges always name their branch.
		{ id: "conn-2", source: "if-1", target: "agent-2", sourcePort: "if-1:billing", targetPort: "agent-2:in" },
		{ id: "conn-3", source: "if-1", target: "agent-3", sourcePort: "if-1:other", targetPort: "agent-3:in" },
	]);
	deepStrictEqual(built.controls, [{
		id: "if-1", kind: "if", x: 150, y: 70,
		branches: [
			// Non-default side kept; the default ("right") would drop.
			{ name: "billing", field: "action", value: "billing", side: "top" },
			{ name: "other", field: "action" },
		],
	}]);
});

attempt("an empty-string branch value serializes as the catch-all (no value key)", () => {
	const built = buildGraph(ifAgents, ifConnections, [{
		id: "if-1", kind: "if", x: 0, y: 0,
		branches: [{ name: "else", field: "action", value: "" }],
	}]);
	deepStrictEqual((built.controls as Array<{ branches: Array<Record<string, unknown>> }>)[0].branches,
		[{ name: "else", field: "action" }]);
});

attempt("the persisted controls load back into the canvas state (round-trip)", () => {
	const built = buildGraph(ifAgents, ifConnections, ifControls);
	const loaded = loadControls(JSON.parse(JSON.stringify(built.controls)));
	deepStrictEqual(loaded, ifControls);
});

attempt("serialization is idempotent across a load", () => {
	const built = buildGraph(ifAgents, ifConnections, ifControls);
	const loaded = loadControls(JSON.parse(JSON.stringify(built.controls)));
	deepStrictEqual(buildGraph(ifAgents, ifConnections, loaded), built);
});

attempt("loadControls is total over malformed records", () => {
	deepStrictEqual(loadControls(undefined), []);
	deepStrictEqual(loadControls("nope"), []);
	deepStrictEqual(loadControls([7, null, { branches: [] }, { id: "if-2", kind: "if", branches: [7, { name: "x" }], x: "5" }]), [
		// A nameless control entry is skipped; a nameless branch survives with
		// an empty name (validation reports it from the file until re-saved).
		{ id: "if-2", kind: "if", x: 5, y: 0, branches: [{ name: "x", field: "" }] },
	]);
});

attempt("the canvas-authored if graph validates and lowers to exactly its hand-authored twin", () => {
	const built = buildGraph(ifAgents, ifConnections, ifControls);
	const twin = buildGraph(twinAgents, twinConnections);
	// The honest file (controls as nodes) is NOT the twin — the twin is what
	// the run path lowers it to. The equivalence is on the lowered form.
	deepStrictEqual(validateGraph(built).ok, true);
	deepStrictEqual(lowerControls(built as never), twin);
	deepStrictEqual(validateGraph(lowerControls(built as never)).ok, true);
});

attempt("a control with no feed is honest invalid wiring (the validator reports it)", () => {
	// The twin carries no edges into if-1 — the control is unfed, exactly what
	// if-source-invalid exists to report; serialization never papers over it.
	const built = buildGraph(twinAgents, twinConnections, ifControls);
	deepStrictEqual(validateGraph(built).ok, false);
	ok(validateGraph(built).errors.some((e) => e.code === "if-source-invalid"));
});

// ---- the `op` round-trip (docs/proposals/loops.md L3: View JSON carries op
// only when ">="; $count rows serialize like any row) ------------------------
{
	const countControls: CanvasControl[] = [
		{ id: "if-1", kind: "if", x: 0, y: 0, branches: [
			{ name: "done", field: "$count", value: "3", op: ">=" },
			{ name: "retry", field: "verdict", value: "fix", side: "top" },
			{ name: "else", field: "" },
		] },
	];
	attempt("op serializes only when >= and round-trips through a load", () => {
		const built = buildGraph(ifAgents, ifConnections, countControls);
		const branches = (built.controls as Array<{ branches: Array<Record<string, unknown>> }>)[0].branches;
		deepStrictEqual(branches[0], { name: "done", field: "$count", value: "3", op: ">=" });
		// An explicit "==" (or the absent default) drops the key — the canvas
		// state holds op only for the non-default.
		const builtExplicit = buildGraph(ifAgents, ifConnections, [{
			id: "if-1", kind: "if", x: 0, y: 0,
			branches: [{ name: "retry", field: "verdict", value: "fix", op: "==", side: "top" }],
		}]);
		deepStrictEqual((builtExplicit.controls as Array<{ branches: Array<Record<string, unknown>> }>)[0].branches,
			[{ name: "retry", field: "verdict", value: "fix", side: "top" }]);
		const loaded = loadControls(JSON.parse(JSON.stringify(built.controls)));
		deepStrictEqual(loaded, countControls);
		deepStrictEqual(buildGraph(ifAgents, ifConnections, loaded), built);
	});
	attempt("loadControls normalizes an unknown op away (validation reports it from the file)", () => {
		const loaded = loadControls([{ id: "if-1", kind: "if", branches: [{ name: "done", field: "$count", value: "3", op: "<" }] }]);
		deepStrictEqual(loaded, [{ id: "if-1", kind: "if", x: 0, y: 0, branches: [{ name: "done", field: "$count", value: "3" }] }]);
	});
}

// ---- the backward-edge assist: cycleClosingFlip -----------------------------
// The persisted-shape helpers the matrix builds on (the helper takes the
// honest graph and the prospective connection as the View JSON carries them —
// wire-id ports, control endpoints by the control rules).
const node = (id: string, extra: Record<string, unknown> = {}) => ({
	id, name: id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out", ...extra,
});
const wire = (id: string, source: string, target: string, sourcePort?: string, targetPort?: string) => ({
	id, source, target,
	...(sourcePort !== undefined ? { sourcePort } : {}),
	...(targetPort !== undefined ? { targetPort } : {}),
});

attempt("a back edge into an unwired default entry closes a cycle and declares it any-of", () => {
	const graph = { agents: [node("a"), node("b")], connections: [wire("c1", "a", "b", "a:out", "b:in")] };
	deepStrictEqual(cycleClosingFlip(graph, wire("c2", "b", "a", "b:out", "a:in")), {
		closesCycle: true,
		inputPorts: [{ name: "in", policy: "any-of" }],
	});
});

attempt("a forward edge closes nothing and flips nothing", () => {
	const graph = { agents: [node("a"), node("b"), node("c")], connections: [wire("c1", "a", "b", "a:out", "b:in")] };
	deepStrictEqual(cycleClosingFlip(graph, wire("c2", "a", "c", "a:out", "c:in")), { closesCycle: false });
});

attempt("an unrelated edge into an already-cyclic graph closes nothing (participation, not presence)", () => {
	const graph = {
		agents: [node("a"), node("b"), node("x"), node("y")],
		connections: [wire("c1", "a", "b", "a:out", "b:in"), wire("c2", "b", "a", "b:out", "a:in"), wire("c5", "x", "y", "x:out", "y:in")],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c3", "b", "y", "b:out", "y:in")), { closesCycle: false });
	// ...while a SECOND loop's back edge, in the same graph, still closes.
	deepStrictEqual(cycleClosingFlip(graph, wire("c4", "y", "x", "y:out", "x:in")), {
		closesCycle: true,
		inputPorts: [{ name: "in", policy: "any-of" }],
	});
});

attempt("the flip rewrites only the entered declared port, preserving bound and side", () => {
	const graph = {
		agents: [
			node("m"),
			node("c", { inputPorts: [{ name: "in" }, { name: "feedback", policy: "all-of", bound: 3, side: "bottom" }] }),
		],
		connections: [wire("c1", "m", "c", "m:out", "c:in"), wire("c2", "c", "m", "c:out", "m:in")],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c3", "m", "c", "m:out", "c:feedback")), {
		closesCycle: true,
		inputPorts: [{ name: "in" }, { name: "feedback", policy: "any-of", bound: 3, side: "bottom" }],
	});
});

attempt("an already any-of entry needs no flip", () => {
	const graph = {
		agents: [
			node("m"),
			node("c", { inputPorts: [{ name: "in" }, { name: "feedback", policy: "any-of", bound: 3 }] }),
		],
		connections: [wire("c1", "m", "c", "m:out", "c:in"), wire("c2", "c", "m", "c:out", "m:in")],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c3", "m", "c", "m:out", "c:feedback")), { closesCycle: true });
});

attempt("a control-sourced branch edge closing the loop flips the targeted agent's entry", () => {
	const graph = {
		agents: [node("k"), node("r"), node("t")],
		connections: [
			wire("c1", "k", "r", "k:out", "r:in"),
			wire("c2", "r", "if-1", "r:out"),
			wire("c3", "if-1", "t", "if-1:done", "t:in"),
		],
		controls: [{ id: "if-1", kind: "if", x: 0, y: 0, branches: [
			{ name: "done", field: "$count", value: "3", op: ">=" },
			{ name: "retry" },
		] }],
	};
	const verdict = cycleClosingFlip(graph, wire("c4", "if-1", "r", "if-1:retry", "r:in"));
	deepStrictEqual(verdict, { closesCycle: true, inputPorts: [{ name: "in", policy: "any-of" }] });
	// Composite: with the flip applied, the seed-once warning never appears and
	// the graph stays valid — the count row is the guard.
	const flipped = {
		...graph,
		agents: graph.agents.map((a) => (a.id === "r" ? { ...a, inputPorts: verdict.inputPorts } : a)),
		connections: [...graph.connections, wire("c4", "if-1", "r", "if-1:retry", "r:in")],
	};
	const result = validateGraph(flipped);
	deepStrictEqual(result.ok, true);
	ok((result.warnings ?? []).some((w) => w.code === "cycle-present"));
	ok(!(result.warnings ?? []).some((w) => w.code === "cycle-entry-all-of"));
});

attempt("a control-targeted feeding edge gives the assist nothing to act on", () => {
	// The feeding edge lowers away — the control owns no input port to flip;
	// the starved entry (if any) speaks through cycle-entry-all-of.
	const graph = {
		agents: [node("k"), node("r")],
		connections: [wire("c1", "k", "r", "k:out", "r:in"), wire("c2", "if-1", "r", "if-1:retry", "r:in")],
		controls: [{ id: "if-1", kind: "if", x: 0, y: 0, branches: [{ name: "retry" }] }],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c3", "r", "if-1", "r:out")), { closesCycle: false });
});

attempt("a hand-edited legacy input wire is not flipped (declaring would orphan it)", () => {
	const graph = {
		agents: [node("a"), node("b", { input: "b:custom-in" })],
		connections: [wire("c1", "b", "a", "b:custom-in", "a:in")],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c2", "a", "b", "a:out", "b:custom-in")), { closesCycle: true });
});

attempt("a wire naming an unknown input port closes but flips nothing", () => {
	const graph = {
		agents: [node("m"), node("c", { inputPorts: [{ name: "in" }] })],
		connections: [wire("c1", "c", "m", "c:out", "m:in")],
	};
	deepStrictEqual(cycleClosingFlip(graph, wire("c2", "m", "c", "m:out", "c:feedback")), { closesCycle: true });
});

attempt("the helper is total over malformed input", () => {
	deepStrictEqual(cycleClosingFlip(null, wire("c1", "a", "b")), { closesCycle: false });
	deepStrictEqual(cycleClosingFlip({ agents: [node("a")], connections: [] }, null), { closesCycle: false });
	deepStrictEqual(cycleClosingFlip({ agents: [node("a")], connections: [] }, { id: "", source: "a", target: "a" }), { closesCycle: false });
	deepStrictEqual(cycleClosingFlip({ agents: [node("a")], connections: [] }, wire("c1", "a", "ghost", "a:out", "ghost:in")), { closesCycle: false });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
