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
		//#region src/execution.ts
		/**
		* Render a value as prompt text: verbatim strings, structured values as JSON.
		* Shared with the message-composition module so the Host prompt framing and
		* the client's result framing render values identically.
		*/
		function renderValue(value) {
			if (typeof value === "string") return value;
			if (value === void 0) return "";
			try {
				return JSON.stringify(value, null, 2);
			} catch {
				return String(value);
			}
		}
		//#endregion
		//#region src/message.ts
		/**
		* Compose the pipeline-level input string from the modal's text and attached
		* file paths. Deterministic: text verbatim, then one "Attached files" block
		* listing one absolute path per line; empty parts are omitted entirely.
		*
		* @param text - the multiline input text (may be empty when files are attached).
		* @param files - attached absolute paths, in attachment order.
		* @returns the composed input string ("" when both are empty).
		*/
		function composePipelineInput(text, files) {
			const parts = [];
			if (typeof text === "string" && text.length > 0) parts.push(text);
			if (Array.isArray(files) && files.length > 0) parts.push("Attached files (absolute paths — read them with your file tools; their contents are not inlined here):\n" + files.map((f) => "- " + String(f)).join("\n"));
			return parts.join("\n\n");
		}
		/**
		* Render the run result's terminal outputs as continue-in-chat text.
		*
		* @param outputs - the contract's `{ [terminalId]: output }` map.
		* @param labelOf - terminal id → display label (agent name).
		* @returns a single output verbatim (values rendered like the prompt framing);
		*   several outputs as one "## <label>" section per terminal; "" when empty.
		*/
		function finalOutputText(outputs, labelOf) {
			const map = outputs ?? {};
			const ids = Object.keys(map);
			if (ids.length === 0) return "";
			if (ids.length === 1) return renderValue(map[ids[0]]);
			return ids.map((id) => "## " + labelOf(id) + "\n" + renderValue(map[id])).join("\n\n");
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
				".pipeline-modal-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
				".pipeline-config{width:380px;max-width:92%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)}",
				".pipeline-config h3{margin:0;font-size:14px;font-weight:600}",
				".pipeline-config .config-row{display:flex;flex-direction:column;gap:4px}",
				".pipeline-config label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-config input,.pipeline-config textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
				".pipeline-config input:focus,.pipeline-config textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-config textarea{min-height:72px;resize:vertical}",
				".pipeline-config .config-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
				".pipeline-btn-run{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
				".pipeline-btn-run:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
				".pipeline-btn-stop{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
				".pipeline-modal{width:560px;max-width:94%;max-height:88%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:auto}",
				".pipeline-modal h3{margin:0;font-size:14px;font-weight:600}",
				".pipeline-modal .modal-row{display:flex;flex-direction:column;gap:4px}",
				".pipeline-modal label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-modal textarea{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%;min-height:96px;resize:vertical}",
				".pipeline-modal input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}",
				".pipeline-modal textarea:focus,.pipeline-modal input:focus,.pipeline-modal select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-modal select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;box-sizing:border-box;width:100%}",
				".pipeline-attach-zone{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}",
				".pipeline-attach-zone.drag{border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-chips{display:flex;flex-wrap:wrap;gap:6px}",
				".pipeline-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 4px 2px 9px;max-width:100%}",
				".pipeline-chip .chip-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}",
				".pipeline-chip .chip-x{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:2px 6px;border-radius:999px}",
				".pipeline-chip .chip-x:hover{color:var(--dsw-alias-state-error-primary)}",
				".pipeline-picker-list{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);max-height:150px;overflow:auto;display:flex;flex-direction:column}",
				".pipeline-picker-row{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;cursor:pointer;user-select:none}",
				".pipeline-picker-row:hover{background:var(--dsw-alias-bg-layer-2)}",
				".pipeline-picker-row .row-kind{flex-shrink:0;font-size:10px;color:var(--dsw-alias-label-secondary);width:52px}",
				".pipeline-picker-row .row-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".pipeline-picker-row .row-add{flex-shrink:0;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:4px;font-size:11px;line-height:1;padding:2px 6px;cursor:pointer}",
				".pipeline-picker-row .row-add:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
				".pipeline-picker-status{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-modal-notice{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
				".pipeline-modal-status{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
				".pipeline-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;align-items:center}",
				".pipeline-modal-actions .spacer{flex:1}",
				".pipeline-result{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
				".pipeline-result-row{display:flex;flex-direction:column;gap:2px}",
				".pipeline-result-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".pipeline-result-value{margin:0;padding:6px 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
				".pipeline-result-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary)}",
				".pipeline-result-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
				".pipeline-input-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
				".pipeline-input-btn:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".pipeline-shell-backdrop{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.5)}",
				".pipeline-shell{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:41;width:min(1200px,94vw);height:min(860px,90vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:hidden}",
				".pipeline-shell-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}",
				".pipeline-shell-head h4{margin:0;font-size:13px;font-weight:600}",
				".pipeline-shell-cwd{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}",
				".pipeline-shell-head .spacer{flex:1}",
				".pipeline-shell .pipeline-view{flex:1;min-height:0;height:auto}",
				".pipeline-shell-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;padding:0 24px;text-align:center}"
			].join("");
			document.head.appendChild(tag);
		}
		const ENDPOINT = "/dsh-agent-pipeline";
		const SAVE_DEBOUNCE_MS = 250;
		/** Stable empty selector results (identity matters to the snapshot hooks). */
		const EMPTY_ROWS = {};
		const EMPTY_ITEMS = [];
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
		/** Resolve a (possibly workspace-relative) path to the absolute form the agent reads. */
		function absolutePath(path, cwd) {
			if (path.startsWith("/")) return path;
			const base = typeof cwd === "string" && cwd.length > 0 ? cwd.replace(/\/+$/, "") : "";
			return base.length > 0 ? base + "/" + path : path;
		}
		function RunModal({ cwd, initialText, initialFiles, running, fileList, onRun, onClose }) {
			const [text, setText] = react.useState(initialText);
			const [files, setFiles] = react.useState(initialFiles);
			const [query, setQuery] = react.useState("");
			const [candidates, setCandidates] = react.useState([]);
			const [pickerState, setPickerState] = react.useState("idle");
			const [manual, setManual] = react.useState("");
			const [notice, setNotice] = react.useState(null);
			const [dragOver, setDragOver] = react.useState(false);
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			function attach(path) {
				const abs = absolutePath(path.trim(), cwd);
				if (abs.length === 0) return;
				setFiles((prev) => prev.indexOf(abs) === -1 ? prev.concat([abs]) : prev);
			}
			function onPickRow(candidate, add) {
				const path = typeof candidate.path === "string" ? candidate.path : "";
				if (path.length === 0) return;
				if (add || candidate.kind !== "directory") attach(path);
				else setQuery(path + "/");
			}
			function onDrop(e) {
				e.preventDefault();
				setDragOver(false);
				const text = e.dataTransfer.getData("text/plain");
				if (typeof text === "string" && text.trim().startsWith("/")) {
					text.split("\n").forEach((line) => {
						if (line.trim().startsWith("/")) attach(line);
					});
					return;
				}
				if (e.dataTransfer.files && e.dataTransfer.files.length > 0) setNotice("The browser hides dropped files' paths — use the picker below (or paste a path).");
			}
			react.useEffect(() => {
				if (fileList === null) return;
				const controller = new AbortController();
				const timer = setTimeout(() => {
					setPickerState("loading");
					fileList(query, controller.signal).then((rows) => {
						if (controller.signal.aborted) return;
						setCandidates(rows.filter((c) => c && typeof c.path === "string" && c.path.length > 0));
						setPickerState("ready");
					}).catch(() => {
						if (controller.signal.aborted) return;
						setCandidates([]);
						setPickerState("error");
					});
				}, 150);
				return () => {
					clearTimeout(timer);
					controller.abort();
				};
			}, [query, fileList]);
			return react.createElement("div", {
				className: "pipeline-modal-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				}
			}, react.createElement("div", { className: "pipeline-modal" }, react.createElement("h3", null, "Run Pipeline"), react.createElement("div", { className: "modal-row" }, react.createElement("label", null, "Input (the first agent receives this)"), react.createElement("textarea", {
				value: text,
				placeholder: "What should the pipeline do?",
				onChange: (e) => {
					setText(e.target.value);
				},
				onKeyDown: stopKey
			})), react.createElement("div", {
				className: "pipeline-attach-zone" + (dragOver ? " drag" : ""),
				onDragOver: (e) => {
					e.preventDefault();
					setDragOver(true);
				},
				onDragLeave: () => {
					setDragOver(false);
				},
				onDrop
			}, files.length > 0 ? react.createElement("div", { className: "pipeline-chips" }, files.map((f) => react.createElement("span", {
				key: f,
				className: "pipeline-chip",
				title: f
			}, react.createElement("span", { className: "chip-path" }, f), react.createElement("button", {
				className: "chip-x",
				title: "Remove",
				onClick: () => {
					setFiles((prev) => prev.filter((p) => p !== f));
				}
			}, "×")))) : react.createElement("div", { className: "pipeline-picker-status" }, "No files attached."), fileList !== null ? react.createElement("input", {
				value: query,
				placeholder: "Attach workspace files — type a path to search…",
				onChange: (e) => {
					setQuery(e.target.value);
				},
				onKeyDown: stopKey
			}) : null, fileList !== null && (pickerState !== "idle" || query.length > 0) ? react.createElement("div", { className: "pipeline-picker-list" }, pickerState === "loading" ? react.createElement("div", { className: "pipeline-picker-row" }, react.createElement("span", { className: "pipeline-picker-status" }, "Searching…")) : null, pickerState === "error" ? react.createElement("div", { className: "pipeline-picker-row" }, react.createElement("span", { className: "pipeline-picker-status" }, "File search unavailable.")) : null, pickerState === "ready" && candidates.length === 0 ? react.createElement("div", { className: "pipeline-picker-row" }, react.createElement("span", { className: "pipeline-picker-status" }, "No matches.")) : null, candidates.map((c) => react.createElement("div", {
				key: c.path,
				className: "pipeline-picker-row",
				onClick: () => {
					onPickRow(c, false);
				}
			}, react.createElement("span", { className: "row-kind" }, c.kind === "directory" ? "dir" : "file"), react.createElement("span", {
				className: "row-path",
				title: c.path
			}, c.path), react.createElement("button", {
				className: "row-add",
				title: "Attach",
				onClick: (e) => {
					e.stopPropagation();
					onPickRow(c, true);
				}
			}, "+ attach")))) : null, react.createElement("div", { className: "pipeline-chips" }, react.createElement("input", {
				value: manual,
				placeholder: "…or paste an absolute path",
				style: {
					flex: "1 1 200px",
					width: "auto"
				},
				onChange: (e) => {
					setManual(e.target.value);
				},
				onKeyDown: (e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						attach(manual);
						setManual("");
					}
					if (e.key === "Escape") onClose();
				}
			}), react.createElement("button", {
				className: "pipeline-btn",
				disabled: manual.trim().length === 0,
				onClick: () => {
					attach(manual);
					setManual("");
				}
			}, "Add")), notice ? react.createElement("div", { className: "pipeline-modal-notice" }, notice) : null), react.createElement("div", { className: "pipeline-picker-status" }, "Files attach as absolute paths only — the first agent reads them with its own tools."), react.createElement("div", { className: "pipeline-modal-actions" }, react.createElement("button", {
				className: "pipeline-btn",
				onClick: onClose
			}, "Cancel"), react.createElement("button", {
				className: "pipeline-btn pipeline-btn-run",
				disabled: running,
				onClick: () => {
					onRun(text, files);
				}
			}, running ? "Running…" : "Run"))));
		}
		function ResultModal({ result, names, targets, busy, status, onContinueChat, onContinueNewSession, onSendTo, onClose }) {
			const [targetId, setTargetId] = react.useState(targets.length > 0 ? targets[0].id : "");
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			const termName = { ...names };
			const rows = [];
			if (result.ok) {
				Object.keys(result.outputs || {}).forEach((id) => {
					const v = result.outputs[id];
					const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
					rows.push(react.createElement("div", {
						key: "o-" + id,
						className: "pipeline-result-row"
					}, react.createElement("div", { className: "pipeline-result-label" }, termName[id] || id), react.createElement("pre", { className: "pipeline-result-value" }, txt)));
				});
				if (Array.isArray(result.runs)) result.runs.forEach((r) => {
					if (r.status && r.status !== "completed") {
						const warn = "agent " + (termName[r.id] || r.id) + ": " + r.status + (r.error ? " — " + r.error : "");
						rows.push(react.createElement("div", {
							key: "w-" + r.id,
							className: "pipeline-result-warn"
						}, warn));
					}
				});
				if (rows.length === 0) rows.push(react.createElement("div", {
					key: "empty",
					className: "pipeline-result-row"
				}, "No terminal output."));
			} else {
				const msg = result.error || "graph is invalid: " + (result.validationErrors || []).map((e) => e.message).join("; ");
				rows.push(react.createElement("div", {
					key: "err",
					className: "pipeline-result-error"
				}, msg));
			}
			const canContinue = result.ok === true;
			return react.createElement("div", {
				className: "pipeline-modal-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				}
			}, react.createElement("div", { className: "pipeline-modal" }, react.createElement("h3", null, result.ok ? "Pipeline Result" : "Pipeline Failed"), react.createElement("div", { className: "pipeline-result" }, rows), canContinue ? react.createElement("div", { className: "modal-row" }, react.createElement("div", {
				className: "pipeline-modal-actions",
				style: { marginTop: 0 }
			}, react.createElement("button", {
				className: "pipeline-btn",
				disabled: busy !== null,
				title: "Prefill this session's composer with the final output (you send it)",
				onClick: onContinueChat
			}, busy === "chat" ? "Working…" : "Continue in chat"), react.createElement("button", {
				className: "pipeline-btn",
				disabled: busy !== null,
				title: "Create a session in this workspace and prefill its composer (you send it)",
				onClick: onContinueNewSession
			}, busy === "new" ? "Working…" : "Continue in a new session")), targets.length > 0 ? react.createElement("div", {
				className: "pipeline-modal-actions",
				style: { marginTop: 0 }
			}, react.createElement("select", {
				value: targetId,
				onChange: (e) => {
					setTargetId(e.target.value);
				},
				onKeyDown: stopKey,
				"aria-label": "Target session"
			}, targets.map((t) => react.createElement("option", {
				key: t.id,
				value: t.id
			}, t.label))), react.createElement("button", {
				className: "pipeline-btn",
				disabled: busy !== null || targetId.length === 0,
				title: "Open that session and prefill its composer (you send it)",
				onClick: () => {
					onSendTo(targetId);
				}
			}, busy === "send" ? "Working…" : "Send to session…")) : null, react.createElement("div", { className: "pipeline-picker-status" }, "Every route only prefills a composer — you review and press send.")) : null, status ? react.createElement("div", { className: "pipeline-modal-status" }, status) : null, react.createElement("div", { className: "pipeline-modal-actions" }, react.createElement("button", {
				className: "pipeline-btn",
				onClick: onClose
			}, "Close"))));
		}
		function PipelineView({ sessionId, useSessions, useWorkspaces, inputActions, openView, services, onDismiss }) {
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
			const [showRunModal, setShowRunModal] = react.useState(false);
			const [running, setRunning] = react.useState(false);
			const [runResult, setRunResult] = react.useState(null);
			const [resultOpen, setResultOpen] = react.useState(false);
			const [continueBusy, setContinueBusy] = react.useState(null);
			const [continueStatus, setContinueStatus] = react.useState(null);
			const runTextRef = react.useRef("");
			const runFilesRef = react.useRef([]);
			/** The in-flight run's fetch AbortController; Stop aborts it (runAbortRef). */
			const runAbortRef = react.useRef(null);
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
			const sessionRows = useSessions((s) => s && s.byId || EMPTY_ROWS);
			const workspaceItems = useWorkspaces ? useWorkspaces((s) => s && s.items || EMPTY_ITEMS) : EMPTY_ITEMS;
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
				setResultOpen(false);
				setShowRunModal(false);
				runTextRef.current = "";
				runFilesRef.current = [];
			}
			function run(text, files) {
				if (running) return;
				runTextRef.current = text;
				runFilesRef.current = files;
				const g = buildGraph(agents, connections);
				const controller = new AbortController();
				runAbortRef.current = controller;
				setRunning(true);
				setRunResult(null);
				setShowRunModal(false);
				fetch("/dsh-agent-pipeline/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						graph: g,
						input: composePipelineInput(text, files)
					}),
					signal: controller.signal
				}).then((r) => {
					return r.text().then((body) => {
						let data = null;
						try {
							data = body.length > 0 ? JSON.parse(body) : null;
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
					runAbortRef.current = null;
					setRunning(false);
					setRunResult(data);
					setResultOpen(true);
				}).catch((err) => {
					runAbortRef.current = null;
					setRunning(false);
					setRunResult({
						ok: false,
						error: err !== null && err.name === "AbortError" ? "Run stopped — the in-flight agent was interrupted." : String(err)
					});
					setResultOpen(true);
				});
			}
			function stopRun() {
				const controller = runAbortRef.current;
				if (controller) controller.abort();
			}
			function queryFiles(query, signal) {
				const remote = services && services.remote;
				if (!remote || !remote.fileReferences || typeof remote.fileReferences.list !== "function") return Promise.reject(/* @__PURE__ */ new Error("file references unavailable"));
				return remote.fileReferences.list(sessionId, query, signal).then((r) => r && r.ok === true && Array.isArray(r.value) ? r.value : []);
			}
			function nameOf(id) {
				for (const a of agents) if (a.id === id) return a.name;
				return id;
			}
			const continueText = runResult && runResult.ok ? finalOutputText(runResult.outputs || {}, nameOf) : "";
			function stageDraft(targetSessionId, text) {
				if (text.length === 0) return false;
				if (targetSessionId === sessionId && inputActions && typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
				const conversation = services && services.conversation;
				if (conversation && conversation.input && typeof conversation.input.shell === "function") try {
					conversation.input.shell(targetSessionId).setDraft(text);
					return true;
				} catch {}
				return false;
			}
			function continueInChat() {
				if (!stageDraft(sessionId, continueText)) {
					setContinueStatus("Composer access is unavailable in this view.");
					return;
				}
				if (typeof openView === "function") openView("chat", "");
				else if (onDismiss) onDismiss();
				setResultOpen(false);
			}
			async function continueInNewSession() {
				setContinueBusy("new");
				setContinueStatus(null);
				try {
					const uiWorkspace = services && services.uiWorkspace;
					const ws = (cwd ? workspaceItems.find((w) => w.path === cwd) : void 0) || workspaceItems.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1);
					if (!ws || typeof ws.workspaceId !== "string" || !uiWorkspace || typeof uiWorkspace.connectWorkspace !== "function") throw new Error("this pipeline's folder is not a connected workspace — connect the folder in the sidebar first");
					const newId = await uiWorkspace.connectWorkspace(ws.workspaceId);
					if (typeof newId !== "string" || newId.length === 0) throw new Error("no session could be created for this workspace");
					const sessions = services && services.sessions;
					if (sessions && typeof sessions.open === "function") sessions.open(newId);
					if (!stageDraft(newId, continueText)) throw new Error("composer access unavailable");
					setResultOpen(false);
					if (onDismiss) onDismiss();
				} catch (err) {
					setContinueStatus("Could not start a new session: " + String(err));
				} finally {
					setContinueBusy(null);
				}
			}
			async function sendToSession(targetId) {
				setContinueBusy("send");
				setContinueStatus(null);
				try {
					const sessions = services && services.sessions;
					if (sessions && typeof sessions.open === "function") sessions.open(targetId);
					if (!stageDraft(targetId, continueText)) throw new Error("composer access unavailable");
					setResultOpen(false);
					if (onDismiss) onDismiss();
				} catch (err) {
					setContinueStatus("Could not stage the output: " + String(err));
				} finally {
					setContinueBusy(null);
				}
			}
			const targets = Object.values(sessionRows).filter((r) => r && typeof r.id === "string" && r.id !== sessionId && r.cwd === cwd && !r.parentId && !r.blank && r.origin !== "subagent").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((r) => {
				const label = r.displayTitle || r.title || r.id;
				return {
					id: r.id,
					label: label + " · " + r.id.slice(-6)
				};
			});
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
			}, "Clear"), runResult && !resultOpen ? react.createElement("button", {
				className: "pipeline-btn",
				title: "Reopen the last run's result",
				onClick: () => {
					setResultOpen(true);
				}
			}, "Result") : null, react.createElement("button", {
				className: "pipeline-btn pipeline-btn-run",
				disabled: running || !validation.ok,
				title: running ? "Running…" : "Open the run dialog",
				onClick: () => {
					setShowRunModal(true);
				}
			}, running ? "Running…" : "Run"), running ? react.createElement("button", {
				key: "pipeline-stop",
				className: "pipeline-btn pipeline-btn-stop",
				title: "Stop the run — interrupts the in-flight agent and skips the rest",
				onClick: stopRun
			}, "Stop") : null), validation.ok ? null : react.createElement("div", { className: "pipeline-issues" }, validation.errors.map((err) => {
				return react.createElement("div", {
					key: err.code + ":" + err.message,
					className: "pipeline-issue"
				}, err.message);
			})), react.createElement("div", { className: "pipeline-body" }, react.createElement("div", { className: "pipeline-palette" }, react.createElement("div", { className: "palette-title" }, "Palette"), react.createElement("div", {
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
			}) : null, showRunModal ? react.createElement(RunModal, {
				cwd,
				initialText: runTextRef.current,
				initialFiles: runFilesRef.current,
				running,
				fileList: services && services.remote && services.remote.fileReferences ? queryFiles : null,
				onRun: run,
				onClose: () => {
					setShowRunModal(false);
				}
			}) : null, runResult && resultOpen ? react.createElement(ResultModal, {
				result: runResult,
				names: agents.reduce((acc, a) => {
					acc[a.id] = a.name;
					return acc;
				}, {}),
				targets,
				busy: continueBusy,
				status: continueStatus,
				onContinueChat: continueInChat,
				onContinueNewSession: continueInNewSession,
				onSendTo: sendToSession,
				onClose: () => {
					setResultOpen(false);
					setContinueStatus(null);
				}
			}) : null);
		}
		/** Shared open state between the sidebar trigger and the shell-overlay panel. */
		function createPanelGate() {
			let open = false;
			const listeners = /* @__PURE__ */ new Set();
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				get() {
					return open;
				},
				set(next) {
					if (open === next) return;
					open = next;
					listeners.forEach((fn) => fn());
				}
			};
		}
		const panelGate = createPanelGate();
		/** A small two-node flow glyph for the trigger (no icon package in the bundle). */
		function PipelineGlyph({ size }) {
			return react.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				"aria-hidden": "true"
			}, react.createElement("circle", {
				cx: 3.5,
				cy: 8,
				r: 2.1,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5
			}), react.createElement("path", {
				d: "M5.6 8h4.8",
				stroke: "currentColor",
				strokeWidth: 1.5
			}), react.createElement("circle", {
				cx: 12.5,
				cy: 8,
				r: 2.1,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5
			}));
		}
		/**
		* The composer tool-row trigger (`conversation.input.left`): a compact icon
		* button that opens the frame-wide panel. The tool row renders in the hero
		* variant too, so this is the entry that works on a brand-new (blank) chat —
		* the harness hides the title bar and tab ring there, and it renders nothing
		* else of ours. Stateless: no hooks, so it cannot break the host's render
		* contract.
		*/
		function PipelineComposerTrigger() {
			return react.createElement("button", {
				type: "button",
				className: "pipeline-input-btn",
				"aria-label": "Pipelines",
				title: "Pipelines",
				onMouseDown: (e) => {
					e.preventDefault();
				},
				onClick: () => {
					panelGate.set(true);
				}
			}, react.createElement(PipelineGlyph, { size: 14 }));
		}
		/**
		* The shell-overlay entry: a one-hook gate so the hook count never changes
		* between closed and open renders; the panel body mounts fresh when opened.
		*/
		function PipelinePanelEntry({ useSessions, useWorkspaces, services }) {
			if (!react.useSyncExternalStore(panelGate.subscribe, panelGate.get)) return null;
			return react.createElement(PipelinePanel, {
				useSessions,
				useWorkspaces,
				services
			});
		}
		/** The frame-wide panel hosting the canvas for the CURRENT session. */
		function PipelinePanel({ useSessions, useWorkspaces, services }) {
			const hasSessions = typeof useSessions === "function";
			const current = hasSessions ? useSessions((s) => s && s.current) : void 0;
			const cwd = hasSessions ? useSessions((s) => {
				const id = s && s.current;
				if (!id || !s.byId) return void 0;
				const row = s.byId[id];
				return row ? row.cwd : void 0;
			}) : void 0;
			const close = () => {
				panelGate.set(false);
			};
			return react.createElement("div", { className: "pipeline-shell-backdrop" }, react.createElement("div", {
				className: "pipeline-shell",
				"data-pipeline-shell": "true"
			}, react.createElement("div", { className: "pipeline-shell-head" }, react.createElement("h4", null, "Pipelines"), cwd ? react.createElement("span", {
				className: "pipeline-shell-cwd",
				title: cwd
			}, cwd) : null, react.createElement("div", { className: "spacer" }), react.createElement("button", {
				className: "pipeline-btn",
				title: "Close the pipelines panel",
				onClick: close
			}, "Close")), hasSessions && typeof current === "string" && current.length > 0 ? PipelineView({
				sessionId: current,
				useSessions,
				useWorkspaces,
				services,
				onDismiss: close
			}) : react.createElement("div", { className: "pipeline-shell-empty" }, hasSessions ? "Open a session to compose and run pipelines — the graph is stored per workspace." : "The session feed is unavailable here; open the Pipelines tab inside a session instead.")));
		}
		const inject = [
			"slots",
			"sessions",
			"uiWorkspace",
			"conversation",
			"remote",
			"remote.fileReferences"
		];
		function apply(ctx) {
			const services = {
				sessions: ctx.sessions,
				uiWorkspace: ctx.uiWorkspace,
				conversation: ctx.conversation,
				remote: ctx.remote
			};
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "pipeline",
				order: 30,
				label: "Pipelines"
			}, (props) => PipelineView({
				sessionId: props.sessionId,
				useSessions: props.useSessions,
				useWorkspaces: props.useWorkspaces,
				inputActions: props.inputActions,
				openView: props.openView,
				services
			})));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "pipeline-trigger",
				order: 40
			}, () => PipelineComposerTrigger()));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "pipeline-panel",
				order: 20
			}, (props) => PipelinePanelEntry({
				useSessions: props.useSessions,
				useWorkspaces: props.useWorkspaces,
				services
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
