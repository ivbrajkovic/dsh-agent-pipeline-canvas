// dsh-agent-pipeline-canvas — browser half.
//
// Hand-written client bundle in the shipped `window.__ModuleLoader__.load`
// format (mirroring dsh-balance-pill): the factory registers lazily; the
// package is picked into the browser roster by dsh-client-modules because
// package.json declares `dsh.client` and exports["./client"].
//
// It registers a "Pipelines" view tab into `conversation.view` (additive,
// replaceRisk: none, order 30) so the canvas is available in EVERY session.
// The view renders the whole node workspace: a palette with a draggable Agent,
// a canvas, node move/select, and output→input connections with directed edges.
//
// Persistence: the graph is backed by the project's `.agent-pipeline/pipeline.json`
// (written by the Host half via the `/dsh-agent-pipeline` route). The view
// recovers the session's workspace root (cwd) from the framework standard kit
// (`useSessions`), loads the saved graph on mount, and persists the graph after
// every structural change (add / delete / clear / connect / move). Because the
// view-ring slot only mounts the active tab, switching away would otherwise
// discard the React-local state — persisting to disk makes the pipeline survive
// tab switches, UI reloads, and reopen. If no cwd is known yet, the canvas
// still works in-memory and quietly awaits load/save.

window.__ModuleLoader__.load({
	id: "dsh-agent-pipeline-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		const CSS_TAG = "dsh-agent-pipeline-canvas/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".pipeline-view{position:relative;display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;font-family:inherit;color:var(--dsw-alias-label-primary)}",
				".pipeline-view .pipeline-toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1)}",
				".pipeline-view .pipeline-toolbar h3{margin:0;font-size:14px;font-weight:600}",
				".pipeline-view .pipeline-toolbar .spacer{flex:1}",
				".pipeline-view .pipeline-toolbar .stat{font-size:12px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-view .pipeline-toolbar .pipeline-validation{margin-left:6px;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);line-height:1}",
				".pipeline-view .pipeline-toolbar .pipeline-validation.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}",
				".pipeline-view .pipeline-toolbar .pipeline-validation.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}",
				".pipeline-issues{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,var(--dsw-alias-border-l1));padding:6px 10px;max-height:120px;overflow:auto;display:flex;flex-direction:column;gap:3px}",
				".pipeline-issue{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.4}",
				".pipeline-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px}",
				".pipeline-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-btn:disabled{opacity:.5;cursor:default}",
				".pipeline-body{flex:1;min-height:0;display:flex;border-top:1px solid var(--dsw-alias-border-l1)}",
				".pipeline-palette{width:170px;flex-shrink:0;background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l1);padding:12px;box-sizing:border-box;overflow:auto}",
				".pipeline-palette .palette-title{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin-bottom:10px}",
				".palette-item{display:flex;align-items:center;gap:8px;cursor:grab;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;padding:10px;font-size:13px;user-select:none}",
				".palette-item:active{cursor:grabbing}",
				".palette-icon{width:12px;height:12px;border-radius:3px;background:var(--dsw-alias-brand-primary)}",
				".pipeline-canvas{position:relative;flex:1;min-height:0;overflow:hidden;background-image:radial-gradient(circle,rgba(128,128,128,.18) 1px,transparent 1px);background-size:20px 20px}",
				".pipeline-canvas:focus{outline:none}",
				".pipeline-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;pointer-events:none;text-align:center;padding:0 20px}",
				".pipeline-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}",
				".pipeline-edge{stroke:var(--dsw-alias-label-secondary);stroke-width:2;fill:none}",
				".pipeline-arrowfill{fill:var(--dsw-alias-label-secondary)}",
				".pipeline-edge-temp{stroke:var(--dsw-alias-brand-primary);stroke-width:2;fill:none;stroke-dasharray:6 4}",
				".pipeline-node{position:absolute;width:150px;height:58px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1.5px solid var(--dsw-alias-border-l2);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:move;user-select:none}",
				".pipeline-node.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}",
				".pipeline-node .node-name{font-size:13px;font-weight:600}",
				".pipeline-node .node-sub{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px}",
				".pipeline-port{position:absolute;top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-overlay);border:2px solid var(--dsw-alias-brand-primary);cursor:crosshair}",
				".pipeline-port.in{left:-8px}",
				".pipeline-port.out{right:-8px;border-color:var(--dsw-alias-state-success-primary)}",
				".pipeline-port.hover{box-shadow:0 0 0 4px var(--dsw-alias-brand-primary)}",
				".pipeline-json{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}",
				".pipeline-json pre{margin:0;padding:10px;max-height:200px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-word}",
				".pipeline-config-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
				".pipeline-config{width:380px;max-width:92%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)}",
				".pipeline-config h3{margin:0;font-size:14px;font-weight:600}",
				".pipeline-config .config-row{display:flex;flex-direction:column;gap:4px}",
				".pipeline-config label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-config input,.pipeline-config textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
				".pipeline-config input:focus,.pipeline-config textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-config textarea{min-height:72px;resize:vertical}",
				".pipeline-config .config-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
				".pipeline-run-input{min-width:140px;flex:0 1 auto;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;box-sizing:border-box}",
				".pipeline-run-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-btn-run{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
				".pipeline-btn-run:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
				".pipeline-result{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,var(--dsw-alias-bg-base));border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 10px;max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
				".pipeline-result-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".pipeline-result-row{display:flex;flex-direction:column;gap:2px}",
				".pipeline-result-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-result-value{margin:0;padding:6px 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
				".pipeline-result-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
				".pipeline-result-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
			].join("");
			document.head.appendChild(tag);
		}

		const ENDPOINT = "/dsh-agent-pipeline";
		const SAVE_DEBOUNCE_MS = 250;

		/** Numeric tail of an id (`agent-12` → 12), used to restore the id counter. */
		function numericSuffix(value) {
			var m = /(\d+)$/.exec(String(value));
			return m ? parseInt(m[1], 10) : 0;
		}

		/** Serialize the internal graph to the wire/persisted shape (matches the View JSON contract). */
		function buildGraph(agents, connections) {
			return {
				agents: agents.map(function (a) {
					return { id: a.id, name: a.name, description: a.description || "", instructions: a.instructions || "", x: Math.round(a.x), y: Math.round(a.y), input: a.id + ":in", output: a.id + ":out" };
				}),
				connections: connections.map(function (c) {
					return { id: c.id, source: c.source, target: c.target, sourcePort: c.source + ":out", targetPort: c.target + ":in" };
				}),
			};
		}

		// ---- Validation (mirror of ./graph.js) --------------------------------
		// A client bundle resolves require() against the platform seed / module
		// table, not against relative files, so it cannot import the Host's
		// ./graph.js. validateGraph / findCycle are therefore mirrored here. They
		// must stay in sync with the canonical pure implementation in lib/graph.js
		// (the Host returns its own result on GET/POST; the browser computes it
		// client-side for live feedback while editing).
		function validateGraph(graph) {
			var errors = [];

			if (graph == null) return { ok: true, errors: errors };
			if (typeof graph !== "object" || Array.isArray(graph)) {
				errors.push({ code: "graph-invalid", message: "pipeline must be an object with agents and connections" });
				return { ok: false, errors: errors };
			}

			if (graph.agents != null && !Array.isArray(graph.agents)) {
				errors.push({ code: "agents-not-array", message: "pipeline 'agents' must be an array" });
			}
			if (graph.connections != null && !Array.isArray(graph.connections)) {
				errors.push({ code: "connections-not-array", message: "pipeline 'connections' must be an array" });
			}

			var agents = Array.isArray(graph.agents) ? graph.agents : [];
			var connections = Array.isArray(graph.connections) ? graph.connections : [];

			var agentIds = new Set();
			var agentById = new Map();

			for (var i = 0; i < agents.length; i++) {
				var agent = agents[i];
				if (agent == null || typeof agent !== "object") {
					errors.push({ code: "agent-invalid", message: "an agent entry is not an object" });
					continue;
				}
				var id = agent.id == null ? "" : String(agent.id);
				if (id.length === 0) {
					errors.push({ code: "agent-missing-id", message: "an agent is missing an id" });
					continue;
				}
				if (agentIds.has(id)) {
					errors.push({ code: "agent-duplicate-id", message: "duplicate agent id \"" + id + "\"" });
					continue;
				}
				agentIds.add(id);
				agentById.set(id, agent);
				if (agent.input != null && (typeof agent.input !== "string" || agent.input.length === 0)) {
					errors.push({ code: "agent-port-invalid", message: "agent \"" + id + "\" has an invalid input port" });
				}
				if (agent.output != null && (typeof agent.output !== "string" || agent.output.length === 0)) {
					errors.push({ code: "agent-port-invalid", message: "agent \"" + id + "\" has an invalid output port" });
				}
			}

			function inputPort(agent) {
				if (agent != null && typeof agent.input === "string" && agent.input.length > 0) return agent.input;
				return (agent != null && agent.id != null ? String(agent.id) : "") + ":in";
			}
			function outputPort(agent) {
				if (agent != null && typeof agent.output === "string" && agent.output.length > 0) return agent.output;
				return (agent != null && agent.id != null ? String(agent.id) : "") + ":out";
			}
			function argStr(value) { return value == null ? "" : String(value); }

			var seenEdges = new Set();

			for (var j = 0; j < connections.length; j++) {
				var conn = connections[j];
				if (conn == null || typeof conn !== "object") {
					errors.push({ code: "connection-invalid", message: "a connection entry is not an object" });
					continue;
				}
				var source = argStr(conn.source);
				var target = argStr(conn.target);
				var sourcePort = argStr(conn.sourcePort);
				var targetPort = argStr(conn.targetPort);

				if (source.length === 0) errors.push({ code: "connection-missing-source", message: "a connection is missing a source agent" });
				if (target.length === 0) errors.push({ code: "connection-missing-target", message: "a connection is missing a target agent" });

				var hasSource = source.length > 0 && agentIds.has(source);
				var hasTarget = target.length > 0 && agentIds.has(target);

				if (source.length > 0 && !agentIds.has(source)) {
					errors.push({ code: "connection-source-missing", message: "connection references unknown source agent \"" + source + "\"" });
				}
				if (target.length > 0 && !agentIds.has(target)) {
					errors.push({ code: "connection-target-missing", message: "connection references unknown target agent \"" + target + "\"" });
				}
				if (source.length > 0 && target.length > 0 && source === target) {
					errors.push({ code: "connection-self", message: "connection " + source + " -> " + target + " connects an agent to itself" });
				}

				var srcAgent = agentById.get(source);
				var tgtAgent = agentById.get(target);
				var canonOut = hasSource ? outputPort(srcAgent) : (source.length > 0 ? source + ":out" : "");
				var canonIn = hasTarget ? inputPort(tgtAgent) : (target.length > 0 ? target + ":in" : "");

				if (hasSource) {
					if (sourcePort.length === 0) {
						errors.push({ code: "connection-missing-source-port", message: "connection from \"" + source + "\" is missing a source port" });
					} else if (sourcePort !== canonOut) {
						errors.push({ code: "connection-source-port-mismatch", message: "connection from \"" + source + "\" uses source port \"" + sourcePort + "\" but \"" + source + "\" output is \"" + canonOut + "\"" });
					}
				}
				if (hasTarget) {
					if (targetPort.length === 0) {
						errors.push({ code: "connection-missing-target-port", message: "connection to \"" + target + "\" is missing a target port" });
					} else if (targetPort !== canonIn) {
						errors.push({ code: "connection-target-port-mismatch", message: "connection to \"" + target + "\" uses target port \"" + targetPort + "\" but \"" + target + "\" input is \"" + canonIn + "\"" });
					}
				}

				if (source.length > 0 && target.length > 0) {
					var key = source + "\u0000" + target + "\u0000" + sourcePort + "\u0000" + targetPort;
					if (seenEdges.has(key)) {
						errors.push({ code: "connection-duplicate", message: "duplicate connection " + source + " -> " + target });
					}
					seenEdges.add(key);
				}
			}

			var cycle = findCycle(agentIds, connections);
			if (cycle.length > 0) {
				errors.push({ code: "cycle", message: "pipeline contains a cycle: " + cycle.join(" -> ") });
			}

			return { ok: errors.length === 0, errors: errors };
		}

		function findCycle(agentIds, connections) {
			var adj = new Map();
			agentIds.forEach(function (id) { adj.set(id, []); });

			for (var i = 0; i < connections.length; i++) {
				var conn = connections[i];
				if (conn == null || typeof conn !== "object") continue;
				var source = conn.source == null ? "" : String(conn.source);
				var target = conn.target == null ? "" : String(conn.target);
				if (source.length === 0 || target.length === 0) continue;
				if (!agentIds.has(source) || !agentIds.has(target)) continue;
				if (source === target) continue;
				adj.get(source).push(target);
			}

			var WHITE = 0, GRAY = 1, BLACK = 2;
			var color = new Map();
			agentIds.forEach(function (id) { color.set(id, WHITE); });
			var stackPath = [];

			function visit(node) {
				color.set(node, GRAY);
				stackPath.push(node);
				var neighbors = adj.get(node) || [];
				for (var k = 0; k < neighbors.length; k++) {
					var next = neighbors[k];
					if (color.get(next) === GRAY) {
						var start = stackPath.indexOf(next);
						return stackPath.slice(start).concat([next]);
					}
					if (color.get(next) === WHITE) {
						var found = visit(next);
						if (found.length > 0) return found;
					}
				}
				stackPath.pop();
				color.set(node, BLACK);
				return [];
			}

			var ids = [];
			agentIds.forEach(function (id) { ids.push(id); });
			for (var m = 0; m < ids.length; m++) {
				if (color.get(ids[m]) === WHITE) {
					var found = visit(ids[m]);
					if (found.length > 0) return found;
				}
			}
			return [];
		}

		// Editable configuration for a single agent: name / description /
		// instructions. Rendered in a modal overlay when an agent is
		// double-clicked; local state is seeded from the agent on mount (the
		// component is keyed by the agent id, so opening a different agent
		// remounts it cleanly). Saving mutates the agent in the graph and lets
		// the debounced persist write it back to pipeline.json.
		function AgentConfigPanel({ agent, onSave, onClose }) {
			var [name, setName] = react.useState(agent.name);
			var [description, setDescription] = react.useState(agent.description);
			var [instructions, setInstructions] = react.useState(agent.instructions);
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			return react.createElement(
				"div",
				{ className: "pipeline-config-overlay", onPointerDown: function (e) { e.stopPropagation(); } },
				react.createElement(
					"div",
					{ className: "pipeline-config" },
					react.createElement("h3", null, "Configure Agent"),
					react.createElement("div", { className: "config-row" },
						react.createElement("label", null, "Name"),
						react.createElement("input", { value: name, onChange: function (e) { setName(e.target.value); }, onKeyDown: stopKey })
					),
					react.createElement("div", { className: "config-row" },
						react.createElement("label", null, "Description"),
						react.createElement("input", { value: description, onChange: function (e) { setDescription(e.target.value); }, onKeyDown: stopKey })
					),
					react.createElement("div", { className: "config-row" },
						react.createElement("label", null, "Instructions"),
						react.createElement("textarea", { value: instructions, onChange: function (e) { setInstructions(e.target.value); }, onKeyDown: stopKey })
					),
					react.createElement("div", { className: "config-actions" },
						react.createElement("button", { className: "pipeline-btn", onClick: onClose }, "Cancel"),
						react.createElement("button", { className: "pipeline-btn", onClick: function () {
							onSave({ id: agent.id, name: name, description: description, instructions: instructions });
						} }, "Save")
					)
				)
			);
		}

		function PipelineView({ sessionId, useSessions }) {
			var NODE_W = 150;
			var NODE_H = 58;
			var [agents, setAgents] = react.useState([]);
			var [connections, setConnections] = react.useState([]);
			var [seq, setSeq] = react.useState(1);
			var [selectedId, setSelectedId] = react.useState(null);
			var [connectCursor, setConnectCursor] = react.useState(null);
			var [hoverTarget, setHoverTarget] = react.useState(null);
			var [showJson, setShowJson] = react.useState(false);
			var [configAgentId, setConfigAgentId] = react.useState(null);
			var [runInput, setRunInput] = react.useState("");
			var [running, setRunning] = react.useState(false);
			var [runResult, setRunResult] = react.useState(null);
			var canvasRef = react.useRef(null);
			var idRef = react.useRef(0);
			var dragRef = react.useRef(null);
			var connectRef = react.useRef(null);
			// Persistence plumbing.
			var cwdRef = react.useRef(undefined);
			var loadedRef = react.useRef(false);
			var skipNextPersistRef = react.useRef(false);
			var saveTimerRef = react.useRef(null);
			var stateRef = react.useRef({ agents: [], connections: [] });

			// The session's workspace root, read off the framework session list
			// (same source the shipped Chat view uses). Undefined until the
			// session summary carries its cwd; until then the view is in-memory.
			var cwd = useSessions(function (s) {
				if (!s || !s.byId) return undefined;
				var entry = s.byId[sessionId];
				return entry ? entry.cwd : undefined;
			});
			cwdRef.current = cwd;

			function newId(prefix) {
				idRef.current += 1;
				return prefix + "-" + idRef.current;
			}
			function canvasPoint(clientX, clientY) {
				var rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : { left: 0, top: 0 };
				return { x: clientX - rect.left, y: clientY - rect.top };
			}
			function addAgent(x, y) {
				var agent = { id: newId("agent"), name: "Agent " + seq, description: "", instructions: "", x: x, y: y };
				setAgents(function (prev) { return prev.concat([agent]); });
				setSeq(function (s) { return s + 1; });
				setSelectedId(agent.id);
				return agent;
			}
			function outPoint(a) { return { x: a.x + NODE_W, y: a.y + NODE_H / 2 }; }
			function inPoint(a) { return { x: a.x, y: a.y + NODE_H / 2 }; }

			// node drag (pointer capture on the node)
			function onNodePointerDown(e, agent) {
				e.preventDefault(); e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				e.currentTarget.setPointerCapture(e.pointerId);
				setSelectedId(agent.id);
				dragRef.current = { id: agent.id, startClientX: e.clientX, startClientY: e.clientY, startX: agent.x, startY: agent.y };
			}
			function onNodePointerMove(e) {
				var d = dragRef.current;
				if (!d) return;
				var nx = d.startX + (e.clientX - d.startClientX);
				var ny = d.startY + (e.clientY - d.startClientY);
				setAgents(function (prev) {
					return prev.map(function (a) { return a.id === d.id ? Object.assign({}, a, { x: nx, y: ny }) : a; });
				});
			}
			function onNodePointerUp() {
				dragRef.current = null;
			}

			// connect output -> input
			function onOutputPointerDown(e, agent) {
				e.preventDefault(); e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				var p = canvasPoint(e.clientX, e.clientY);
				connectRef.current = { from: agent.id, cursor: { x: p.x, y: p.y }, hoverTarget: null };
				setConnectCursor({ x: p.x, y: p.y });
				setSelectedId(agent.id);
			}
			function onInputPointerEnter(e, agent) {
				e.stopPropagation();
				if (!connectRef.current) return;
				connectRef.current.hoverTarget = agent.id;
				setHoverTarget(agent.id);
			}
			function onInputPointerLeave(e, agent) {
				if (connectRef.current && connectRef.current.hoverTarget === agent.id) {
					connectRef.current.hoverTarget = null;
					setHoverTarget(null);
				}
			}
			function onContainerPointerMove(e) {
				var c = connectRef.current;
				if (!c) return;
				var p = canvasPoint(e.clientX, e.clientY);
				c.cursor = p;
				setConnectCursor({ x: p.x, y: p.y });
			}
			function onContainerPointerUp() {
				var c = connectRef.current;
				if (!c) return;
				var target = c.hoverTarget;
				if (target != null && target !== c.from) {
					var exists = connections.some(function (conn) { return conn.source === c.from && conn.target === target; });
					if (!exists) {
						setConnections(function (prev) { return prev.concat([{ id: newId("conn"), source: c.from, target: target }]); });
					}
				}
				connectRef.current = null;
				setHoverTarget(null);
				setConnectCursor(null);
			}
			function onContainerPointerLeave() {
				if (connectRef.current) {
					connectRef.current = null;
					setHoverTarget(null);
					setConnectCursor(null);
				}
			}
			function onCanvasPointerDown(e) {
				if (canvasRef.current) canvasRef.current.focus();
				setSelectedId(null);
				if (connectRef.current) {
					connectRef.current = null;
					setHoverTarget(null);
					setConnectCursor(null);
				}
			}

			function addAgentFromToolbar() {
				var n = agents.length;
				addAgent(60 + (n % 4) * 40, 40 + (n % 6) * 34);
			}
			function deleteSelected() {
				if (!selectedId) return;
				setAgents(function (prev) { return prev.filter(function (a) { return a.id !== selectedId; }); });
				setConnections(function (prev) { return prev.filter(function (c) { return c.source !== selectedId && c.target !== selectedId; }); });
				setSelectedId(null);
			}
			function clearAll() {
				setAgents([]); setConnections([]); setSelectedId(null); setHoverTarget(null); setConnectCursor(null);
				dragRef.current = null; connectRef.current = null;
				setSeq(1); idRef.current = 0;
				setRunResult(null);
			}

			// Run the pipeline: POST the snapshot the user currently sees (the
			// graph as-is, plus the pipeline input and the session id) to the
			// Host's /run route, which executes it sequentially and returns the
			// contract's `{ outputs: { [terminalId]: output } }` shape.
			function run() {
				if (running) return;
				var g = buildGraph(agents, connections);
				setRunning(true);
				setRunResult(null);
				fetch(ENDPOINT + "/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: sessionId, graph: g, input: runInput }),
				})
					.then(function (r) {
						return r.text().then(function (text) {
							var data = null;
							try { data = text.length > 0 ? JSON.parse(text) : null; } catch (e) { data = null; }
							if (!r.ok) return { ok: false, error: (data && data.error) ? data.error : ("HTTP " + r.status) };
							return data || { ok: false, error: "empty response" };
						});
					})
					.then(function (data) { setRunning(false); setRunResult(data); })
					.catch(function (err) { setRunning(false); setRunResult({ ok: false, error: String(err) }); });
			}
			function onKeyDown(e) {
				if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
				if (e.key === "Escape") { if (connectRef.current) { connectRef.current = null; setHoverTarget(null); setConnectCursor(null); } }
			}
			function handleDragOver(e) { e.preventDefault(); }
			function handleCanvasDrop(e) {
				e.preventDefault();
				if (e.dataTransfer.getData("application/x-pipeline-agent") === "agent") {
					var p = canvasPoint(e.clientX, e.clientY);
					addAgent(p.x - NODE_W / 2, p.y - NODE_H / 2);
				}
			}

			// Load the saved graph once the workspace root is known.
			react.useEffect(function () {
				if (typeof cwd !== "string" || cwd.length === 0) return;
				var cancelled = false;
				fetch(ENDPOINT + "?cwd=" + encodeURIComponent(cwd), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (data) {
						if (cancelled) return;
						var p = data && data.ok === true ? data.pipeline : null;
						var as = p && Array.isArray(p.agents) ? p.agents : [];
						var cs = p && Array.isArray(p.connections) ? p.connections : [];
						skipNextPersistRef.current = true;
						loadedRef.current = true;
						setAgents(as.map(function (a) {
							return { id: String(a.id), name: String(a.name), description: String(a.description || ""), instructions: String(a.instructions || ""), x: Number(a.x) || 0, y: Number(a.y) || 0 };
						}));
						setConnections(cs.map(function (c) {
							return { id: String(c.id), source: String(c.source), target: String(c.target) };
						}));
						var maxId = 0;
						as.forEach(function (a) { var n = numericSuffix(a.id); if (n > maxId) maxId = n; });
						cs.forEach(function (c) { var n = numericSuffix(c.id); if (n > maxId) maxId = n; });
						idRef.current = maxId;
						var maxSeq = 0;
						as.forEach(function (a) {
							var m = /^Agent\s+(\d+)$/.exec(String(a.name));
							var v = m ? parseInt(m[1], 10) : 0;
							if (v > maxSeq) maxSeq = v;
						});
						setSeq(maxSeq + 1);
					})
					.catch(function () { loadedRef.current = true; });
				return function () { cancelled = true; };
			}, [cwd]);

			// Persist on every graph change (debounced so an in-progress drag
			// coalesces into one write). A freshly-loaded graph is not written
			// back immediately (skipNextPersist consumed once).
			react.useEffect(function () {
				stateRef.current = { agents: agents, connections: connections };
				if (!loadedRef.current) return;
				if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return; }
				if (!(typeof cwdRef.current === "string" && cwdRef.current.length > 0)) return;
				if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
				saveTimerRef.current = setTimeout(function () {
					saveTimerRef.current = null;
					var g = buildGraph(stateRef.current.agents, stateRef.current.connections);
					fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd: cwdRef.current, graph: g }),
					}).catch(function () {});
				}, SAVE_DEBOUNCE_MS);
			}, [agents, connections]);

			var gesture = connectRef.current;
			var edges = [];
			connections.forEach(function (c) {
				var src = null, tgt = null;
				for (var i = 0; i < agents.length; i++) {
					if (agents[i].id === c.source) src = agents[i];
					if (agents[i].id === c.target) tgt = agents[i];
				}
				if (!src || !tgt) return;
				var s = outPoint(src), t = inPoint(tgt);
				var d = "M" + s.x + " " + s.y + " C" + (s.x + 60) + " " + s.y + " " + (t.x - 60) + " " + t.y + " " + t.x + " " + t.y;
				edges.push(react.createElement("path", { key: c.id, d: d, className: "pipeline-edge", markerEnd: "url(#pipeline-arrow)" }));
			});
			var tempEdge = null;
			if (gesture) {
				var src0 = null;
				for (var j = 0; j < agents.length; j++) if (agents[j].id === gesture.from) src0 = agents[j];
				if (src0) {
					var s0 = outPoint(src0);
					var cx = gesture.cursor ? gesture.cursor.x : s0.x;
					var cy = gesture.cursor ? gesture.cursor.y : s0.y;
					var d0 = "M" + s0.x + " " + s0.y + " C" + (s0.x + 60) + " " + s0.y + " " + (cx - 60) + " " + cy + " " + cx + " " + cy;
					tempEdge = react.createElement("path", { d: d0, className: "pipeline-edge-temp" });
				}
			}

			var nodes = agents.map(function (agent) {
				var selected = agent.id === selectedId;
				var hoveredIn = hoverTarget === agent.id && gesture;
				return react.createElement(
					"div",
					{
						key: agent.id,
						className: "pipeline-node" + (selected ? " selected" : ""),
						style: { left: agent.x + "px", top: agent.y + "px" },
						"data-agent-id": agent.id,
						onPointerDown: function (e) { onNodePointerDown(e, agent); },
						onPointerMove: onNodePointerMove,
						onPointerUp: onNodePointerUp,
						onDoubleClick: function (e) { e.stopPropagation(); setConfigAgentId(agent.id); },
					},
					react.createElement("div", { className: "node-name" }, agent.name),
					react.createElement("div", { className: "node-sub" }, agent.id),
					react.createElement("div", {
						className: "pipeline-port in" + (hoveredIn ? " hover" : ""),
						onPointerEnter: function (e) { onInputPointerEnter(e, agent); },
						onPointerLeave: function (e) { onInputPointerLeave(e, agent); },
						onPointerDown: function (e) { e.preventDefault(); e.stopPropagation(); },
						onDoubleClick: function (e) { e.stopPropagation(); },
						title: "Input",
					}),
					react.createElement("div", {
						className: "pipeline-port out",
						onPointerDown: function (e) { onOutputPointerDown(e, agent); },
						onDoubleClick: function (e) { e.stopPropagation(); },
						title: "Output",
					})
				);
			});

			var graphData = buildGraph(agents, connections);
			var validation = validateGraph(graphData);
			var jsonText = JSON.stringify(graphData, null, 2);

			var resultRows = null;
			if (runResult) {
				var termName = {};
				agents.forEach(function (a) { termName[a.id] = a.name; });
				resultRows = [];
				if (runResult.ok) {
					Object.keys(runResult.outputs || {}).forEach(function (id) {
						var v = runResult.outputs[id];
						var txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
						resultRows.push(react.createElement("div", { key: "o-" + id, className: "pipeline-result-row" },
							react.createElement("div", { className: "pipeline-result-label" }, termName[id] || id),
							react.createElement("pre", { className: "pipeline-result-value" }, txt)));
					});
					if (Array.isArray(runResult.runs)) {
						runResult.runs.forEach(function (r) {
							if (r.status && r.status !== "completed") {
								var warn = "agent " + (termName[r.id] || r.id) + ": " + r.status + (r.error ? " — " + r.error : "");
								resultRows.push(react.createElement("div", { key: "w-" + r.id, className: "pipeline-result-warn" }, warn));
							}
						});
					}
					if (resultRows.length === 0) {
						resultRows.push(react.createElement("div", { key: "empty", className: "pipeline-result-row" }, "No terminal output."));
					}
				} else {
					var msg = runResult.error || ("graph is invalid: " + (runResult.validationErrors || []).map(function (e) { return e.message; }).join("; "));
					resultRows.push(react.createElement("div", { key: "err", className: "pipeline-result-error" }, msg));
				}
			}

			var configAgent = null;
			for (var k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];

			return react.createElement(
				"div",
				{
					className: "pipeline-view",
					onPointerMove: onContainerPointerMove,
					onPointerUp: onContainerPointerUp,
					onPointerLeave: onContainerPointerLeave,
				},
				react.createElement(
					"div",
					{ className: "pipeline-toolbar" },
					react.createElement("h3", null, "Agent Pipeline"),
					react.createElement("div", { className: "spacer" }),
					react.createElement("span", { className: "stat" }, agents.length + " agents · " + connections.length + " connections"),
					react.createElement(
						"span",
						{
							className: "pipeline-validation" + (validation.ok ? " ok" : " err"),
							title: validation.ok ? "Graph is a valid DAG" : "Graph has validation issues (see the issue list below)",
							role: "status",
						},
						validation.ok ? "Valid" : validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")
					),
					react.createElement("button", { className: "pipeline-btn", onClick: addAgentFromToolbar }, "+ Add Agent"),
					react.createElement("button", { className: "pipeline-btn", onClick: deleteSelected, disabled: !selectedId }, "Delete"),
					react.createElement("button", { className: "pipeline-btn", onClick: function () { setShowJson(!showJson); } }, showJson ? "Hide JSON" : "View JSON"),
					react.createElement("button", { className: "pipeline-btn", onClick: clearAll }, "Clear"),
					react.createElement("input", {
						className: "pipeline-run-input",
						type: "text",
						placeholder: "Pipeline input",
						value: runInput,
						onChange: function (e) { setRunInput(e.target.value); },
					}),
					react.createElement("button", {
						className: "pipeline-btn pipeline-btn-run",
						disabled: running || !validation.ok,
						title: running ? "Running…" : "Run the pipeline",
						onClick: run,
					}, running ? "Running…" : "Run")
				),
				validation.ok ? null : react.createElement(
					"div",
					{ className: "pipeline-issues" },
					validation.errors.map(function (err) {
						return react.createElement("div", { key: err.code + ":" + err.message, className: "pipeline-issue" }, err.message);
					})
				),
				runResult ? react.createElement(
					"div",
					{ className: "pipeline-result" },
					react.createElement("div", { className: "pipeline-result-title" }, runResult.ok ? "Pipeline result" : "Pipeline failed"),
					resultRows
				) : null,
				react.createElement(
					"div",
					{ className: "pipeline-body" },
					react.createElement(
						"div",
						{ className: "pipeline-palette" },
						react.createElement("div", { className: "palette-title" }, "Palette"),
						react.createElement(
							"div",
							{
								className: "palette-item",
								draggable: true,
								onDragStart: function (e) {
									e.dataTransfer.setData("application/x-pipeline-agent", "agent");
									e.dataTransfer.effectAllowed = "copy";
								},
							},
							react.createElement("div", { className: "palette-icon" }),
							"Agent"
						)
					),
					react.createElement(
						"div",
						{
							className: "pipeline-canvas",
							ref: canvasRef,
							tabIndex: 0,
							onDragOver: handleDragOver,
							onDrop: handleCanvasDrop,
							onPointerDown: onCanvasPointerDown,
							onKeyDown: onKeyDown,
						},
						react.createElement(
							"svg",
							{ className: "pipeline-edges" },
							react.createElement(
								"defs",
								null,
								react.createElement(
									"marker",
									{ id: "pipeline-arrow", markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: "auto", markerUnits: "strokeWidth" },
									react.createElement("path", { d: "M0,0 L6,3 L0,6 Z", className: "pipeline-arrowfill" })
								)
							),
							edges,
							tempEdge
						),
						nodes,
						agents.length === 0 ? react.createElement("div", { className: "pipeline-hint" }, "Drag an Agent from the palette onto the canvas") : null
					)
				),
				showJson ? react.createElement("div", { className: "pipeline-json" }, react.createElement("pre", null, jsonText)) : null,
				configAgent ? react.createElement(AgentConfigPanel, {
					key: configAgent.id,
					agent: configAgent,
					onSave: function (updated) {
						setAgents(function (prev) {
							return prev.map(function (a) {
								return a.id === updated.id
									? Object.assign({}, a, { name: updated.name, description: updated.description, instructions: updated.instructions })
									: a;
							});
						});
						setConfigAgentId(null);
					},
					onClose: function () { setConfigAgentId(null); },
				}) : null
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{ name: "conversation.view", id: "pipeline", order: 30, label: "Pipelines" },
					PipelineView
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
