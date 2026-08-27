// dsh-agent-pipeline-canvas — browser client bundle build (tsdown).
//
// Emits the window.__ModuleLoader__.load({ id, factory }) artifact the browser
// module system consumes. This mirrors the standalone-plugin convention (the
// harness's internal clientBundle preset is workspace-coupled and cannot be
// reused by a plugin outside the repo): mark the loader module-table requests
// (`react`) as external and inline everything else — including the shared
// validateGraph from ./src/graph.ts, which is what removes the Host/browser
// duplication.
import { defineConfig } from "tsdown";

/** Specifiers resolved from the browser module table (never bundled). */
const MODULE_TABLE_EXTERNALS = new Set(["react"]);

export default defineConfig(() => ({
	name: "dsh-agent-pipeline-canvas/client",
	entry: { client: "src/client.ts" },
	// Browser bundle lands next to the node half (single lib/ artifact dir; the
	// entryFileNames pin keeps it exactly lib/client.js).
	outDir: "lib",
	format: ["cjs"],
	platform: "browser",
	target: "es2024",
	fixedExtension: false,
	dts: false,
	clean: false,
	deps: {
		// Module-table rows stay require()'d; every non-shared dep (the shared
		// graph/execution modules, React already external below) is inlined.
		neverBundle: (specifier) => MODULE_TABLE_EXTERNALS.has(specifier),
		alwaysBundle: (specifier) => !MODULE_TABLE_EXTERNALS.has(specifier),
	},
	outputOptions: {
		entryFileNames: "client.js",
		banner: `window.__ModuleLoader__.load({ id: "dsh-agent-pipeline-canvas", factory: (require) => {`,
		footer: "return module.exports; } });",
		intro: "var module = { exports: {} }; var exports = module.exports;",
	},
}));
