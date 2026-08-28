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
export {};
//# sourceMappingURL=types.js.map