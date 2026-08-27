import type { ValidationResult } from "./types.ts";
/**
 * Validate a pipeline graph against the DAG contract above.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined
 *   (an absent pipeline is valid: there is simply nothing to run).
 * @returns `{ ok, errors }` where `ok` is true only when `errors` is empty.
 *   Each error is `{ code, message }`; `code` is a stable discriminator (link of
 *   the class of problem) and `message` is a human-readable, targeted string
 *   (e.g. which agent / connection / port is at fault).
 */
export declare function validateGraph(graph: unknown): ValidationResult;
//# sourceMappingURL=graph.d.ts.map