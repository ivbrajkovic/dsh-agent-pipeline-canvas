// dsh-agent-pipeline-canvas — browser client bundle build (tsdown).
//
// Emits the window.__ModuleLoader__.load({ id, factory }) artifact the browser
// module system consumes. This mirrors the standalone-plugin convention (the
// harness's internal clientBundle preset is workspace-coupled and cannot be
// reused by a plugin outside the repo): mark the loader module-table requests
// (`react`, `react/jsx-runtime` — the automatic JSX runtime — plus the
// `@deepseek-ai/dsh-client-ui-primitives` platform module whose Menu primitive
// backs the node context menu; all three are in the harness's
// PLATFORM_MODULES union, statically seeded into the frozen module table) as
// external and inline everything else
// — including the shared validateGraph from ./src/graph.ts, which is what
// removes the Host/browser duplication.
//
// CSS: a `.css` import anywhere in the client source compiles into the same
// contract the harness preset emits for plain stylesheets (its
// dsh-css-global-inline loader) — a tagged <style data-plugin="<plugin id>"
// data-plugin-css="<plugin id>/<file name>"> injector that runs once at
// factory materialization (the module system's claimStyles() then owns the
// tag for HMR bookkeeping). This is a compile-FREE passthrough: lightningcss
// is not among this package's toolchain symlinks, and the sheets are flat and
// prefix-scoped (every class is `.pipeline-*` / `.config-*`), so the text
// ships as written.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { defineConfig } from "tsdown";

/** Specifiers resolved from the browser module table (never bundled). */
const MODULE_TABLE_EXTERNALS = new Set([
	"react",
	"react/jsx-runtime",
	// Host platform module (deepseek-harness PLATFORM_MODULES): the Menu
	// primitive behind the node context menu. Types come from the local shim
	// src/ui/ui-primitives.d.ts — the package is not a devDependency here.
	"@deepseek-ai/dsh-client-ui-primitives",
]);

const PLUGIN_ID = "dsh-agent-pipeline-canvas";

/** Virtual-id wrapper so tsdown's own CSS pipeline never sees the import. */
const CSS_VIRTUAL_PREFIX = "\0pipeline-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

/** Emit one plugin-owned style injector (same shape as the preset's). */
function styleInjectionModule(fileId: string, css: string): string {
	const tagId = PLUGIN_ID + "/styles/" + fileId.split("/").pop();
	return [
		`const css = ${JSON.stringify(css)};`,
		`const tagId = ${JSON.stringify(tagId)};`,
		"if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
		"  const tag = document.createElement('style');",
		`  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
		"  tag.dataset.pluginCss = tagId;",
		"  tag.textContent = css;",
		"  document.head.appendChild(tag);",
		"}",
		"export {};",
	].join("\n");
}

export default defineConfig(() => ({
	name: PLUGIN_ID + "/client",
	entry: { client: "src/client.tsx" },
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
	plugins: [
		{
			name: "pipeline-css-inline",
			resolveId(source: string, importer: string | undefined) {
				if (importer === undefined) return null;
				if (!source.endsWith(".css") || source.endsWith(".module.css")) return null;
				// CWD-relative: the virtual id surfaces verbatim in the bundle's
				//#region comments, which ship in the committed lib/client.js.
				const abs = resolvePath(dirname(importer), source);
				return CSS_VIRTUAL_PREFIX + relative(process.cwd(), abs) + CSS_VIRTUAL_SUFFIX;
			},
			async load(this: { addWatchFile(id: string): void }, virtualId: string) {
				if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
				const relId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
				const fileId = resolvePath(process.cwd(), relId);
				// The virtual id otherwise hides the physical sheet from the watch graph.
				this.addWatchFile(fileId);
				return styleInjectionModule(fileId, await readFile(fileId, "utf8"));
			},
		},
	],
	outputOptions: {
		entryFileNames: "client.js",
		banner: `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {`,
		footer: "return module.exports; } });",
		intro: "var module = { exports: {} }; var exports = module.exports;",
	},
}));
