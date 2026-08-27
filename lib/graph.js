// dsh-agent-pipeline-canvas — graph semantics (shared by the Host, the runner,
// and the browser half; the browser bundle inlines this module via tsdown).
//
// This module is the single authoritative definition of the pipeline's graph
// contract. It is intentionally PURE (no Node or browser APIs, no I/O, no React)
// so it can be imported by the Host (./index.ts), the executor (./runner.ts),
// and the browser client (./client.ts, where tsdown bundles it in), and its
// behaviour can be exercised in a plain Node script (see test/validate.test.ts).
//
// ## The graph, treated as a DAG
//
// The pipeline is a directed acyclic graph (DAG) over the two arrays a plugin
// already persists (see the graph-data-model contract in README.md):
//
//   {
//     "agents":      [ { "id", "name", "description", "instructions",
//                        "x", "y", "input": "<id>:in", "output": "<id>:out" }, ... ],
//     "connections": [ { "id", "source", "target",
//                        "sourcePort": "<source>:out", "targetPort": "<target>:in" }, ... ]
//   }
//
// Semantics (the contract execution will depend on):
//   - A->B means A's output becomes input to B (an edge from A's output port to
//     B's input port). Edges carry no weight/order.
//   - Each agent has exactly ONE input port and ONE output port, named by the
//     `<id>:in` / `<id>:out` convention (declared on the agent as `input` /
//     `output`; buildGraph always emits them).
//   - Fan-out is allowed: an output port may feed many targets (a source id may
//     appear in many connections).
//   - Fan-in is allowed: an input port may receive from many sources (a target
//     id may appear in many connections, all targeting the same input port).
//   - A node with zero incoming edges is a START node (runs with no upstream
//     input yet). A node with zero outgoing edges is a TERMINAL node. A node
//     runs only after EVERY incoming dependency has produced its output.
//   - The graph must not contain a directed cycle, self-connection, duplicate
//     edge, or a reference to a missing agent/port; see validateGraph.
//
// The format is kept backward-compatible: nothing here changes what is written
// to pipeline.json or what the canvas emits. This module only ADDS the
// validation a runner will rely on; it does not alter the on-disk shape.
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
export function validateGraph(graph) {
    const errors = [];
    if (graph == null)
        return { ok: true, errors };
    if (typeof graph !== "object" || Array.isArray(graph)) {
        errors.push({ code: "graph-invalid", message: "pipeline must be an object with agents and connections" });
        return { ok: false, errors };
    }
    const asGraph = graph;
    if (asGraph.agents != null && !Array.isArray(asGraph.agents)) {
        errors.push({ code: "agents-not-array", message: "pipeline 'agents' must be an array" });
    }
    if (asGraph.connections != null && !Array.isArray(asGraph.connections)) {
        errors.push({ code: "connections-not-array", message: "pipeline 'connections' must be an array" });
    }
    const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
    const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];
    const agentIds = new Set();
    const agentById = new Map();
    // ---- Agents ------------------------------------------------------------
    for (const agent of agents) {
        if (agent == null || typeof agent !== "object") {
            errors.push({ code: "agent-invalid", message: "an agent entry is not an object" });
            continue;
        }
        const rec = agent;
        const id = rec.id == null ? "" : String(rec.id);
        if (id.length === 0) {
            errors.push({ code: "agent-missing-id", message: "an agent is missing an id" });
            continue;
        }
        if (agentIds.has(id)) {
            errors.push({ code: "agent-duplicate-id", message: `duplicate agent id "${id}"` });
            continue;
        }
        agentIds.add(id);
        agentById.set(id, agent);
        // Ports are optional on the wire (buildGraph always emits them), but if
        // present they must be non-empty strings.
        if (rec.input != null && (typeof rec.input !== "string" || rec.input.length === 0)) {
            errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid input port` });
        }
        if (rec.output != null && (typeof rec.output !== "string" || rec.output.length === 0)) {
            errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid output port` });
        }
    }
    // ---- Port resolution (declared port, else the id:in / id:out convention) ----
    function inputPort(agent) {
        const rec = agent;
        if (rec != null && typeof rec.input === "string" && rec.input.length > 0)
            return rec.input;
        return `${rec != null && rec.id != null ? String(rec.id) : ""}:in`;
    }
    function outputPort(agent) {
        const rec = agent;
        if (rec != null && typeof rec.output === "string" && rec.output.length > 0)
            return rec.output;
        return `${rec != null && rec.id != null ? String(rec.id) : ""}:out`;
    }
    function argStr(value) {
        return value == null ? "" : String(value);
    }
    // ---- Connections -------------------------------------------------------
    const seenEdges = new Set();
    for (const conn of connections) {
        if (conn == null || typeof conn !== "object") {
            errors.push({ code: "connection-invalid", message: "a connection entry is not an object" });
            continue;
        }
        const rec = conn;
        const source = argStr(rec.source);
        const target = argStr(rec.target);
        const sourcePort = argStr(rec.sourcePort);
        const targetPort = argStr(rec.targetPort);
        if (source.length === 0)
            errors.push({ code: "connection-missing-source", message: "a connection is missing a source agent" });
        if (target.length === 0)
            errors.push({ code: "connection-missing-target", message: "a connection is missing a target agent" });
        const hasSource = source.length > 0 && agentIds.has(source);
        const hasTarget = target.length > 0 && agentIds.has(target);
        if (source.length > 0 && !agentIds.has(source)) {
            errors.push({ code: "connection-source-missing", message: `connection references unknown source agent "${source}"` });
        }
        if (target.length > 0 && !agentIds.has(target)) {
            errors.push({ code: "connection-target-missing", message: `connection references unknown target agent "${target}"` });
        }
        if (source.length > 0 && target.length > 0 && source === target) {
            errors.push({ code: "connection-self", message: `connection ${source} -> ${target} connects an agent to itself` });
        }
        // Port validity: a connection must point from the source's OUTPUT port to
        // the target's INPUT port, and those ports must match the agents' declared
        // ports (so the executor genuinely wires A's output into B's input).
        const srcAgent = agentById.get(source);
        const tgtAgent = agentById.get(target);
        const canonOut = hasSource ? outputPort(srcAgent) : source.length > 0 ? `${source}:out` : "";
        const canonIn = hasTarget ? inputPort(tgtAgent) : target.length > 0 ? `${target}:in` : "";
        if (hasSource) {
            if (sourcePort.length === 0) {
                errors.push({ code: "connection-missing-source-port", message: `connection from "${source}" is missing a source port` });
            }
            else if (sourcePort !== canonOut) {
                errors.push({ code: "connection-source-port-mismatch", message: `connection from "${source}" uses source port "${sourcePort}" but "${source}" output is "${canonOut}"` });
            }
        }
        if (hasTarget) {
            if (targetPort.length === 0) {
                errors.push({ code: "connection-missing-target-port", message: `connection to "${target}" is missing a target port` });
            }
            else if (targetPort !== canonIn) {
                errors.push({ code: "connection-target-port-mismatch", message: `connection to "${target}" uses target port "${targetPort}" but "${target}" input is "${canonIn}"` });
            }
        }
        // Duplicate edge: same source -> target (with the same ports). The canvas
        // already blocks a repeated source->target in one session, but the file can
        // gain duplicates from concurrent writers or a manual edit, so they are
        // reported here.
        if (source.length > 0 && target.length > 0) {
            const key = `${source}\u0000${target}\u0000${sourcePort}\u0000${targetPort}`;
            if (seenEdges.has(key)) {
                errors.push({ code: "connection-duplicate", message: `duplicate connection ${source} -> ${target}` });
            }
            seenEdges.add(key);
        }
    }
    // ---- Cycle detection ---------------------------------------------------
    const cycle = findCycle(agentIds, connections);
    if (cycle.length > 0) {
        errors.push({ code: "cycle", message: `pipeline contains a cycle: ${cycle.join(" -> ")}` });
    }
    return { ok: errors.length === 0, errors };
}
/**
 * Detect a directed cycle among the given agents/edges and, when found, return
 * the cycle as a closed path `[a, b, c, a]` (last == first). Self-connections
 * are excluded here because they are reported as `connection-self` separately;
 * they are still cycles, but reporting them once with a targeted message is
 * clearer than folding them into a generic "cycle" error.
 *
 * @param agentIds - the set of known agent ids (the graph's node universe).
 * @param connections - the raw connections array.
 * @returns an empty array when the graph is acyclic, else the cycle path.
 */
function findCycle(agentIds, connections) {
    const adj = new Map();
    for (const id of agentIds)
        adj.set(id, []);
    for (const conn of connections) {
        if (conn == null || typeof conn !== "object")
            continue;
        const rec = conn;
        const source = rec.source == null ? "" : String(rec.source);
        const target = rec.target == null ? "" : String(rec.target);
        if (source.length === 0 || target.length === 0)
            continue;
        if (!agentIds.has(source) || !agentIds.has(target))
            continue;
        if (source === target)
            continue;
        adj.get(source)?.push(target);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of agentIds)
        color.set(id, WHITE);
    const stackPath = [];
    function visit(node) {
        color.set(node, GRAY);
        stackPath.push(node);
        for (const next of adj.get(node) ?? []) {
            if (color.get(next) === GRAY) {
                // Back edge to an ancestor on the current DFS stack -> cycle.
                const start = stackPath.indexOf(next);
                return stackPath.slice(start).concat([next]);
            }
            if (color.get(next) === WHITE) {
                const found = visit(next);
                if (found.length > 0)
                    return found;
            }
        }
        stackPath.pop();
        color.set(node, BLACK);
        return [];
    }
    for (const id of agentIds) {
        if (color.get(id) === WHITE) {
            const found = visit(id);
            if (found.length > 0)
                return found;
        }
    }
    return [];
}
//# sourceMappingURL=graph.js.map