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
import { validateGraph } from "../lib/graph.js";
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
