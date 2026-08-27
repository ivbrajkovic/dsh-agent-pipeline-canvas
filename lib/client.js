window.__ModuleLoader__.load({
	id: "dsh-agent-pipeline-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/graph.ts
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
		function validateGraph(graph) {
			const errors = [];
			if (graph == null) return {
				ok: true,
				errors
			};
			if (typeof graph !== "object" || Array.isArray(graph)) {
				errors.push({
					code: "graph-invalid",
					message: "pipeline must be an object with agents and connections"
				});
				return {
					ok: false,
					errors
				};
			}
			const asGraph = graph;
			if (asGraph.agents != null && !Array.isArray(asGraph.agents)) errors.push({
				code: "agents-not-array",
				message: "pipeline 'agents' must be an array"
			});
			if (asGraph.connections != null && !Array.isArray(asGraph.connections)) errors.push({
				code: "connections-not-array",
				message: "pipeline 'connections' must be an array"
			});
			const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
			const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];
			const agentIds = /* @__PURE__ */ new Set();
			const agentById = /* @__PURE__ */ new Map();
			for (const agent of agents) {
				if (agent == null || typeof agent !== "object") {
					errors.push({
						code: "agent-invalid",
						message: "an agent entry is not an object"
					});
					continue;
				}
				const rec = agent;
				const id = rec.id == null ? "" : String(rec.id);
				if (id.length === 0) {
					errors.push({
						code: "agent-missing-id",
						message: "an agent is missing an id"
					});
					continue;
				}
				if (agentIds.has(id)) {
					errors.push({
						code: "agent-duplicate-id",
						message: `duplicate agent id "${id}"`
					});
					continue;
				}
				agentIds.add(id);
				agentById.set(id, agent);
				if (rec.input != null && (typeof rec.input !== "string" || rec.input.length === 0)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid input port`
				});
				if (rec.output != null && (typeof rec.output !== "string" || rec.output.length === 0)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid output port`
				});
			}
			function inputPort(agent) {
				const rec = agent;
				if (rec != null && typeof rec.input === "string" && rec.input.length > 0) return rec.input;
				return `${rec != null && rec.id != null ? String(rec.id) : ""}:in`;
			}
			function outputPort(agent) {
				const rec = agent;
				if (rec != null && typeof rec.output === "string" && rec.output.length > 0) return rec.output;
				return `${rec != null && rec.id != null ? String(rec.id) : ""}:out`;
			}
			function argStr(value) {
				return value == null ? "" : String(value);
			}
			const seenEdges = /* @__PURE__ */ new Set();
			for (const conn of connections) {
				if (conn == null || typeof conn !== "object") {
					errors.push({
						code: "connection-invalid",
						message: "a connection entry is not an object"
					});
					continue;
				}
				const rec = conn;
				const source = argStr(rec.source);
				const target = argStr(rec.target);
				const sourcePort = argStr(rec.sourcePort);
				const targetPort = argStr(rec.targetPort);
				if (source.length === 0) errors.push({
					code: "connection-missing-source",
					message: "a connection is missing a source agent"
				});
				if (target.length === 0) errors.push({
					code: "connection-missing-target",
					message: "a connection is missing a target agent"
				});
				const hasSource = source.length > 0 && agentIds.has(source);
				const hasTarget = target.length > 0 && agentIds.has(target);
				if (source.length > 0 && !agentIds.has(source)) errors.push({
					code: "connection-source-missing",
					message: `connection references unknown source agent "${source}"`
				});
				if (target.length > 0 && !agentIds.has(target)) errors.push({
					code: "connection-target-missing",
					message: `connection references unknown target agent "${target}"`
				});
				if (source.length > 0 && target.length > 0 && source === target) errors.push({
					code: "connection-self",
					message: `connection ${source} -> ${target} connects an agent to itself`
				});
				const srcAgent = agentById.get(source);
				const tgtAgent = agentById.get(target);
				const canonOut = hasSource ? outputPort(srcAgent) : source.length > 0 ? `${source}:out` : "";
				const canonIn = hasTarget ? inputPort(tgtAgent) : target.length > 0 ? `${target}:in` : "";
				if (hasSource) {
					if (sourcePort.length === 0) errors.push({
						code: "connection-missing-source-port",
						message: `connection from "${source}" is missing a source port`
					});
					else if (sourcePort !== canonOut) errors.push({
						code: "connection-source-port-mismatch",
						message: `connection from "${source}" uses source port "${sourcePort}" but "${source}" output is "${canonOut}"`
					});
				}
				if (hasTarget) {
					if (targetPort.length === 0) errors.push({
						code: "connection-missing-target-port",
						message: `connection to "${target}" is missing a target port`
					});
					else if (targetPort !== canonIn) errors.push({
						code: "connection-target-port-mismatch",
						message: `connection to "${target}" uses target port "${targetPort}" but "${target}" input is "${canonIn}"`
					});
				}
				if (source.length > 0 && target.length > 0) {
					const key = `${source}\u0000${target}\u0000${sourcePort}\u0000${targetPort}`;
					if (seenEdges.has(key)) errors.push({
						code: "connection-duplicate",
						message: `duplicate connection ${source} -> ${target}`
					});
					seenEdges.add(key);
				}
			}
			const cycle = findCycle(agentIds, connections);
			if (cycle.length > 0) errors.push({
				code: "cycle",
				message: `pipeline contains a cycle: ${cycle.join(" -> ")}`
			});
			return {
				ok: errors.length === 0,
				errors
			};
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
			const adj = /* @__PURE__ */ new Map();
			for (const id of agentIds) adj.set(id, []);
			for (const conn of connections) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = rec.source == null ? "" : String(rec.source);
				const target = rec.target == null ? "" : String(rec.target);
				if (source.length === 0 || target.length === 0) continue;
				if (!agentIds.has(source) || !agentIds.has(target)) continue;
				if (source === target) continue;
				adj.get(source)?.push(target);
			}
			const WHITE = 0, GRAY = 1, BLACK = 2;
			const color = /* @__PURE__ */ new Map();
			for (const id of agentIds) color.set(id, WHITE);
			const stackPath = [];
			function visit(node) {
				color.set(node, GRAY);
				stackPath.push(node);
				for (const next of adj.get(node) ?? []) {
					if (color.get(next) === GRAY) {
						const start = stackPath.indexOf(next);
						return stackPath.slice(start).concat([next]);
					}
					if (color.get(next) === WHITE) {
						const found = visit(next);
						if (found.length > 0) return found;
					}
				}
				stackPath.pop();
				color.set(node, BLACK);
				return [];
			}
			for (const id of agentIds) if (color.get(id) === WHITE) {
				const found = visit(id);
				if (found.length > 0) return found;
			}
			return [];
		}
		//#endregion
		//#region src/client.ts
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
				".pipeline-result-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}"
			].join("");
			document.head.appendChild(tag);
		}
		const ENDPOINT = "/dsh-agent-pipeline";
		const SAVE_DEBOUNCE_MS = 250;
		/** Numeric tail of an id (`agent-12` → 12), used to restore the id counter. */
		function numericSuffix(value) {
			const m = /(\d+)$/.exec(String(value));
			return m ? parseInt(m[1], 10) : 0;
		}
		/** Serialize the internal graph to the wire/persisted shape (matches the View JSON contract). */
		function buildGraph(agents, connections) {
			return {
				agents: agents.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description || "",
					instructions: a.instructions || "",
					x: Math.round(a.x),
					y: Math.round(a.y),
					input: a.id + ":in",
					output: a.id + ":out"
				})),
				connections: connections.map((c) => ({
					id: c.id,
					source: c.source,
					target: c.target,
					sourcePort: c.source + ":out",
					targetPort: c.target + ":in"
				}))
			};
		}
		function AgentConfigPanel({ agent, onSave, onClose }) {
			const [name, setName] = react.useState(agent.name);
			const [description, setDescription] = react.useState(agent.description);
			const [instructions, setInstructions] = react.useState(agent.instructions);
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			return react.createElement("div", {
				className: "pipeline-config-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				}
			}, react.createElement("div", { className: "pipeline-config" }, react.createElement("h3", null, "Configure Agent"), react.createElement("div", { className: "config-row" }, react.createElement("label", null, "Name"), react.createElement("input", {
				value: name,
				onChange: (e) => {
					setName(e.target.value);
				},
				onKeyDown: stopKey
			})), react.createElement("div", { className: "config-row" }, react.createElement("label", null, "Description"), react.createElement("input", {
				value: description,
				onChange: (e) => {
					setDescription(e.target.value);
				},
				onKeyDown: stopKey
			})), react.createElement("div", { className: "config-row" }, react.createElement("label", null, "Instructions"), react.createElement("textarea", {
				value: instructions,
				onChange: (e) => {
					setInstructions(e.target.value);
				},
				onKeyDown: stopKey
			})), react.createElement("div", { className: "config-actions" }, react.createElement("button", {
				className: "pipeline-btn",
				onClick: onClose
			}, "Cancel"), react.createElement("button", {
				className: "pipeline-btn",
				onClick: () => {
					onSave({
						id: agent.id,
						name,
						description,
						instructions
					});
				}
			}, "Save"))));
		}
		function PipelineView({ sessionId, useSessions }) {
			const NODE_W = 150;
			const NODE_H = 58;
			const [agents, setAgents] = react.useState([]);
			const [connections, setConnections] = react.useState([]);
			const [seq, setSeq] = react.useState(1);
			const [selectedId, setSelectedId] = react.useState(null);
			const [connectCursor, setConnectCursor] = react.useState(null);
			const [hoverTarget, setHoverTarget] = react.useState(null);
			const [showJson, setShowJson] = react.useState(false);
			const [configAgentId, setConfigAgentId] = react.useState(null);
			const [runInput, setRunInput] = react.useState("");
			const [running, setRunning] = react.useState(false);
			const [runResult, setRunResult] = react.useState(null);
			const canvasRef = react.useRef(null);
			const idRef = react.useRef(0);
			const dragRef = react.useRef(null);
			const connectRef = react.useRef(null);
			const cwdRef = react.useRef(void 0);
			const loadedRef = react.useRef(false);
			const skipNextPersistRef = react.useRef(false);
			const saveTimerRef = react.useRef(null);
			const stateRef = react.useRef({
				agents: [],
				connections: []
			});
			const cwd = useSessions((s) => {
				if (!s || !s.byId) return void 0;
				const entry = s.byId[sessionId];
				return entry ? entry.cwd : void 0;
			});
			cwdRef.current = cwd;
			function newId(prefix) {
				idRef.current += 1;
				return prefix + "-" + idRef.current;
			}
			function canvasPoint(clientX, clientY) {
				const rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : {
					left: 0,
					top: 0
				};
				return {
					x: clientX - rect.left,
					y: clientY - rect.top
				};
			}
			function addAgent(x, y) {
				const agent = {
					id: newId("agent"),
					name: "Agent " + seq,
					description: "",
					instructions: "",
					x,
					y
				};
				setAgents((prev) => prev.concat([agent]));
				setSeq((s) => s + 1);
				setSelectedId(agent.id);
				return agent;
			}
			function outPoint(a) {
				return {
					x: a.x + NODE_W,
					y: a.y + NODE_H / 2
				};
			}
			function inPoint(a) {
				return {
					x: a.x,
					y: a.y + NODE_H / 2
				};
			}
			function onNodePointerDown(e, agent) {
				e.preventDefault();
				e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				e.currentTarget.setPointerCapture(e.pointerId);
				setSelectedId(agent.id);
				dragRef.current = {
					id: agent.id,
					startClientX: e.clientX,
					startClientY: e.clientY,
					startX: agent.x,
					startY: agent.y
				};
			}
			function onNodePointerMove(e) {
				const d = dragRef.current;
				if (!d) return;
				const nx = d.startX + (e.clientX - d.startClientX);
				const ny = d.startY + (e.clientY - d.startClientY);
				setAgents((prev) => prev.map((a) => a.id === d.id ? {
					...a,
					x: nx,
					y: ny
				} : a));
			}
			function onNodePointerUp() {
				dragRef.current = null;
			}
			function onOutputPointerDown(e, agent) {
				e.preventDefault();
				e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				const p = canvasPoint(e.clientX, e.clientY);
				connectRef.current = {
					from: agent.id,
					cursor: {
						x: p.x,
						y: p.y
					},
					hoverTarget: null
				};
				setConnectCursor({
					x: p.x,
					y: p.y
				});
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
				const c = connectRef.current;
				if (!c) return;
				const p = canvasPoint(e.clientX, e.clientY);
				c.cursor = p;
				setConnectCursor({
					x: p.x,
					y: p.y
				});
			}
			function onContainerPointerUp() {
				const c = connectRef.current;
				if (!c) return;
				const target = c.hoverTarget;
				if (target != null && target !== c.from) {
					if (!connections.some((conn) => conn.source === c.from && conn.target === target)) setConnections((prev) => prev.concat([{
						id: newId("conn"),
						source: c.from,
						target
					}]));
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
				const n = agents.length;
				addAgent(60 + n % 4 * 40, 40 + n % 6 * 34);
			}
			function deleteSelected() {
				if (!selectedId) return;
				setAgents((prev) => prev.filter((a) => a.id !== selectedId));
				setConnections((prev) => prev.filter((c) => c.source !== selectedId && c.target !== selectedId));
				setSelectedId(null);
			}
			function clearAll() {
				setAgents([]);
				setConnections([]);
				setSelectedId(null);
				setHoverTarget(null);
				setConnectCursor(null);
				dragRef.current = null;
				connectRef.current = null;
				setSeq(1);
				idRef.current = 0;
				setRunResult(null);
			}
			function run() {
				if (running) return;
				const g = buildGraph(agents, connections);
				setRunning(true);
				setRunResult(null);
				fetch("/dsh-agent-pipeline/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						graph: g,
						input: runInput
					})
				}).then((r) => {
					return r.text().then((text) => {
						let data = null;
						try {
							data = text.length > 0 ? JSON.parse(text) : null;
						} catch (e) {
							data = null;
						}
						if (!r.ok) return {
							ok: false,
							error: data && data.error ? data.error : "HTTP " + r.status
						};
						return data || {
							ok: false,
							error: "empty response"
						};
					});
				}).then((data) => {
					setRunning(false);
					setRunResult(data);
				}).catch((err) => {
					setRunning(false);
					setRunResult({
						ok: false,
						error: String(err)
					});
				});
			}
			function onKeyDown(e) {
				if (e.key === "Delete" || e.key === "Backspace") {
					e.preventDefault();
					deleteSelected();
				}
				if (e.key === "Escape") {
					if (connectRef.current) {
						connectRef.current = null;
						setHoverTarget(null);
						setConnectCursor(null);
					}
				}
			}
			function handleDragOver(e) {
				e.preventDefault();
			}
			function handleCanvasDrop(e) {
				e.preventDefault();
				if (e.dataTransfer.getData("application/x-pipeline-agent") === "agent") {
					const p = canvasPoint(e.clientX, e.clientY);
					addAgent(p.x - NODE_W / 2, p.y - NODE_H / 2);
				}
			}
			react.useEffect(() => {
				if (typeof cwd !== "string" || cwd.length === 0) return;
				let cancelled = false;
				fetch("/dsh-agent-pipeline?cwd=" + encodeURIComponent(cwd), { cache: "no-store" }).then((r) => r.json()).then((data) => {
					if (cancelled) return;
					const p = data && data.ok === true ? data.pipeline : null;
					const as = p && Array.isArray(p.agents) ? p.agents : [];
					const cs = p && Array.isArray(p.connections) ? p.connections : [];
					skipNextPersistRef.current = true;
					loadedRef.current = true;
					setAgents(as.map((a) => ({
						id: String(a.id),
						name: String(a.name),
						description: String(a.description || ""),
						instructions: String(a.instructions || ""),
						x: Number(a.x) || 0,
						y: Number(a.y) || 0
					})));
					setConnections(cs.map((c) => ({
						id: String(c.id),
						source: String(c.source),
						target: String(c.target)
					})));
					let maxId = 0;
					as.forEach((a) => {
						const n = numericSuffix(a.id);
						if (n > maxId) maxId = n;
					});
					cs.forEach((c) => {
						const n = numericSuffix(c.id);
						if (n > maxId) maxId = n;
					});
					idRef.current = maxId;
					let maxSeq = 0;
					as.forEach((a) => {
						const m = /^Agent\s+(\d+)$/.exec(String(a.name));
						const v = m ? parseInt(m[1], 10) : 0;
						if (v > maxSeq) maxSeq = v;
					});
					setSeq(maxSeq + 1);
				}).catch(() => {
					loadedRef.current = true;
				});
				return () => {
					cancelled = true;
				};
			}, [cwd]);
			react.useEffect(() => {
				stateRef.current = {
					agents,
					connections
				};
				if (!loadedRef.current) return;
				if (skipNextPersistRef.current) {
					skipNextPersistRef.current = false;
					return;
				}
				if (!(typeof cwdRef.current === "string" && cwdRef.current.length > 0)) return;
				if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
				saveTimerRef.current = setTimeout(() => {
					saveTimerRef.current = null;
					const g = buildGraph(stateRef.current.agents, stateRef.current.connections);
					fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							cwd: cwdRef.current,
							graph: g
						})
					}).catch(() => {});
				}, SAVE_DEBOUNCE_MS);
			}, [agents, connections]);
			const gesture = connectRef.current;
			const edges = [];
			connections.forEach((c) => {
				let src = null, tgt = null;
				for (let i = 0; i < agents.length; i++) {
					if (agents[i].id === c.source) src = agents[i];
					if (agents[i].id === c.target) tgt = agents[i];
				}
				if (!src || !tgt) return;
				const s = outPoint(src), t = inPoint(tgt);
				const d = "M" + s.x + " " + s.y + " C" + (s.x + 60) + " " + s.y + " " + (t.x - 60) + " " + t.y + " " + t.x + " " + t.y;
				edges.push(react.createElement("path", {
					key: c.id,
					d,
					className: "pipeline-edge",
					markerEnd: "url(#pipeline-arrow)"
				}));
			});
			let tempEdge = null;
			if (gesture) {
				let src0 = null;
				for (let j = 0; j < agents.length; j++) if (agents[j].id === gesture.from) src0 = agents[j];
				if (src0) {
					const s0 = outPoint(src0);
					const cx = gesture.cursor ? gesture.cursor.x : s0.x;
					const cy = gesture.cursor ? gesture.cursor.y : s0.y;
					const d0 = "M" + s0.x + " " + s0.y + " C" + (s0.x + 60) + " " + s0.y + " " + (cx - 60) + " " + cy + " " + cx + " " + cy;
					tempEdge = react.createElement("path", {
						d: d0,
						className: "pipeline-edge-temp"
					});
				}
			}
			const nodes = agents.map((agent) => {
				const selected = agent.id === selectedId;
				const hoveredIn = hoverTarget === agent.id && gesture;
				return react.createElement("div", {
					key: agent.id,
					className: "pipeline-node" + (selected ? " selected" : ""),
					style: {
						left: agent.x + "px",
						top: agent.y + "px"
					},
					"data-agent-id": agent.id,
					onPointerDown: (e) => {
						onNodePointerDown(e, agent);
					},
					onPointerMove: onNodePointerMove,
					onPointerUp: onNodePointerUp,
					onDoubleClick: (e) => {
						e.stopPropagation();
						setConfigAgentId(agent.id);
					}
				}, react.createElement("div", { className: "node-name" }, agent.name), react.createElement("div", { className: "node-sub" }, agent.id), react.createElement("div", {
					className: "pipeline-port in" + (hoveredIn ? " hover" : ""),
					onPointerEnter: (e) => {
						onInputPointerEnter(e, agent);
					},
					onPointerLeave: (e) => {
						onInputPointerLeave(e, agent);
					},
					onPointerDown: (e) => {
						e.preventDefault();
						e.stopPropagation();
					},
					onDoubleClick: (e) => {
						e.stopPropagation();
					},
					title: "Input"
				}), react.createElement("div", {
					className: "pipeline-port out",
					onPointerDown: (e) => {
						onOutputPointerDown(e, agent);
					},
					onDoubleClick: (e) => {
						e.stopPropagation();
					},
					title: "Output"
				}));
			});
			const graphData = buildGraph(agents, connections);
			const validation = validateGraph(graphData);
			const jsonText = JSON.stringify(graphData, null, 2);
			let resultRows = null;
			if (runResult) {
				const termName = {};
				agents.forEach((a) => {
					termName[a.id] = a.name;
				});
				resultRows = [];
				if (runResult.ok) {
					Object.keys(runResult.outputs || {}).forEach((id) => {
						const v = runResult.outputs[id];
						const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
						resultRows.push(react.createElement("div", {
							key: "o-" + id,
							className: "pipeline-result-row"
						}, react.createElement("div", { className: "pipeline-result-label" }, termName[id] || id), react.createElement("pre", { className: "pipeline-result-value" }, txt)));
					});
					if (Array.isArray(runResult.runs)) runResult.runs.forEach((r) => {
						if (r.status && r.status !== "completed") {
							const warn = "agent " + (termName[r.id] || r.id) + ": " + r.status + (r.error ? " — " + r.error : "");
							resultRows.push(react.createElement("div", {
								key: "w-" + r.id,
								className: "pipeline-result-warn"
							}, warn));
						}
					});
					if (resultRows.length === 0) resultRows.push(react.createElement("div", {
						key: "empty",
						className: "pipeline-result-row"
					}, "No terminal output."));
				} else {
					const msg = runResult.error || "graph is invalid: " + (runResult.validationErrors || []).map((e) => e.message).join("; ");
					resultRows.push(react.createElement("div", {
						key: "err",
						className: "pipeline-result-error"
					}, msg));
				}
			}
			let configAgent = null;
			for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];
			return react.createElement("div", {
				className: "pipeline-view",
				onPointerMove: onContainerPointerMove,
				onPointerUp: onContainerPointerUp,
				onPointerLeave: onContainerPointerLeave
			}, react.createElement("div", { className: "pipeline-toolbar" }, react.createElement("h3", null, "Agent Pipeline"), react.createElement("div", { className: "spacer" }), react.createElement("span", { className: "stat" }, agents.length + " agents · " + connections.length + " connections"), react.createElement("span", {
				className: "pipeline-validation" + (validation.ok ? " ok" : " err"),
				title: validation.ok ? "Graph is a valid DAG" : "Graph has validation issues (see the issue list below)",
				role: "status"
			}, validation.ok ? "Valid" : validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")), react.createElement("button", {
				className: "pipeline-btn",
				onClick: addAgentFromToolbar
			}, "+ Add Agent"), react.createElement("button", {
				className: "pipeline-btn",
				onClick: deleteSelected,
				disabled: !selectedId
			}, "Delete"), react.createElement("button", {
				className: "pipeline-btn",
				onClick: () => {
					setShowJson(!showJson);
				}
			}, showJson ? "Hide JSON" : "View JSON"), react.createElement("button", {
				className: "pipeline-btn",
				onClick: clearAll
			}, "Clear"), react.createElement("input", {
				className: "pipeline-run-input",
				type: "text",
				placeholder: "Pipeline input",
				value: runInput,
				onChange: (e) => {
					setRunInput(e.target.value);
				}
			}), react.createElement("button", {
				className: "pipeline-btn pipeline-btn-run",
				disabled: running || !validation.ok,
				title: running ? "Running…" : "Run the pipeline",
				onClick: run
			}, running ? "Running…" : "Run")), validation.ok ? null : react.createElement("div", { className: "pipeline-issues" }, validation.errors.map((err) => {
				return react.createElement("div", {
					key: err.code + ":" + err.message,
					className: "pipeline-issue"
				}, err.message);
			})), runResult ? react.createElement("div", { className: "pipeline-result" }, react.createElement("div", { className: "pipeline-result-title" }, runResult.ok ? "Pipeline result" : "Pipeline failed"), resultRows) : null, react.createElement("div", { className: "pipeline-body" }, react.createElement("div", { className: "pipeline-palette" }, react.createElement("div", { className: "palette-title" }, "Palette"), react.createElement("div", {
				className: "palette-item",
				draggable: true,
				onDragStart: (e) => {
					e.dataTransfer.setData("application/x-pipeline-agent", "agent");
					e.dataTransfer.effectAllowed = "copy";
				}
			}, react.createElement("div", { className: "palette-icon" }), "Agent")), react.createElement("div", {
				className: "pipeline-canvas",
				ref: canvasRef,
				tabIndex: 0,
				onDragOver: handleDragOver,
				onDrop: handleCanvasDrop,
				onPointerDown: onCanvasPointerDown,
				onKeyDown
			}, react.createElement("svg", { className: "pipeline-edges" }, react.createElement("defs", null, react.createElement("marker", {
				id: "pipeline-arrow",
				markerWidth: 8,
				markerHeight: 8,
				refX: 6,
				refY: 3,
				orient: "auto",
				markerUnits: "strokeWidth"
			}, react.createElement("path", {
				d: "M0,0 L6,3 L0,6 Z",
				className: "pipeline-arrowfill"
			}))), edges, tempEdge), nodes, agents.length === 0 ? react.createElement("div", { className: "pipeline-hint" }, "Drag an Agent from the palette onto the canvas") : null)), showJson ? react.createElement("div", { className: "pipeline-json" }, react.createElement("pre", null, jsonText)) : null, configAgent ? react.createElement(AgentConfigPanel, {
				key: configAgent.id,
				agent: configAgent,
				onSave: (updated) => {
					setAgents((prev) => prev.map((a) => a.id === updated.id ? {
						...a,
						name: updated.name,
						description: updated.description,
						instructions: updated.instructions
					} : a));
					setConfigAgentId(null);
				},
				onClose: () => {
					setConfigAgentId(null);
				}
			}) : null);
		}
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "pipeline",
				order: 30,
				label: "Pipelines"
			}, PipelineView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
