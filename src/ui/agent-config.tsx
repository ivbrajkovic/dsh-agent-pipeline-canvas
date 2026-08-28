// The agent configuration modal: a wide, two-column card. The left column is
// the agent's behavior — name / description / system prompt / instructions.
// The system prompt is REAL system-prompt text: the harness spawn provider
// installs it as the child's scoped `deployment:persona` system-prompt
// section (order 0), replacing that one slot for this child alone — the
// standard prompt (identity, policies, tool explanations) is inherited
// untouched (see docs/SYSTEM-PROMPT.md). The right column holds the agent's
// settings — agent options (provider / model / reasoning-effort / max-tokens),
// tool filter, delegation depth, and an object-rooted JSON output schema.
// Everything is always visible (no disclosure). Opened from the agent
// node's edit button; local state is seeded from the agent on mount (the
// component is keyed by the agent id, so opening a different agent remounts
// it cleanly). Saving mutates the agent in the graph — settings are
// canonicalized to the shapes the runner forwards — and lets the debounced
// persist write it back to pipeline.json. An output-schema text that does not
// parse as a JSON object blocks Save (live error inline); everything else is
// free-form and validated by the harness at run time.
//
// Provider and Model read the Host's options route (`llm.listProviders()` and
// one route's advertised models, fetched server-side): both are selects whose
// empty value inherits the parent Agent's options. Provider lists the
// registered provider routes; Model lists the selected provider's advertised
// models (while inheriting, the deployment default route's). The directory
// loads on mount — for the agent's saved provider when it has one — and
// refetches on a provider change, which also resets the model (model ids are
// provider-scoped). A current value missing from the fetched directory (a
// stale saved id, a failed fetch) is kept as an extra option, so it stays
// visible and savable; any failure just shrinks the lists.
import * as React from 'react';
import type { AgentSettings } from '../types.ts';
import { ENDPOINT, type CanvasAgent } from './shared.ts';
import './agent-config.css';

/** One registered provider route (the Host options route's shape). */
interface ProviderOption {
  id: string;
  name: string;
}

/** One model a provider's adapter advertises (the Host options route's shape). */
interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

interface OptionsCatalog {
  providers: ProviderOption[];
  models: ModelOption[];
  /** The provider route the `models` list belongs to ("" when none). */
  provider: string;
}

function AgentConfigPanel({
  agent,
  onSave,
  onClose,
}: {
  agent: CanvasAgent;
  onSave: (updated: {
    id: string;
    name: string;
    description: string;
    systemPrompt?: string;
    instructions: string;
    settings?: AgentSettings;
    breakpoint?: boolean;
  }) => void;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(agent.name);
  const [description, setDescription] = React.useState(agent.description);
  const [systemPrompt, setSystemPrompt] = React.useState(
    agent.systemPrompt ?? '',
  );
  const [instructions, setInstructions] = React.useState(agent.instructions);
  const [breakpoint, setBreakpoint] = React.useState(
    agent.breakpoint === true,
  );
  const settings = agent.settings;
  const [maxDepth, setMaxDepth] = React.useState(
    settings?.maxDepth != null ? String(settings.maxDepth) : '',
  );
  const [provider, setProvider] = React.useState(
    settings?.agentOptions?.provider ?? '',
  );
  const [model, setModel] = React.useState(settings?.agentOptions?.model ?? '');
  const [reasoningEffort, setReasoningEffort] = React.useState(
    settings?.agentOptions?.reasoningEffort ?? '',
  );
  const [maxTokens, setMaxTokens] = React.useState(
    settings?.agentOptions?.maxTokens != null
      ? String(settings.agentOptions.maxTokens)
      : '',
  );
  const [filterMode, setFilterMode] = React.useState(
    settings?.toolFilter?.deny != null ? 'deny' : 'allow',
  );
  const [filterNames, setFilterNames] = React.useState(
    (
      (settings?.toolFilter?.allow ??
        settings?.toolFilter?.deny ??
        []) as unknown[]
    )
      .filter((t): t is string => typeof t === 'string')
      .join(', '),
  );
  const [schemaText, setSchemaText] = React.useState(
    settings?.outputSchema != null
      ? JSON.stringify(settings.outputSchema, null, 2)
      : '',
  );
  // The provider/model directory (loaded on mount, aborted on unmount).
  const [catalog, setCatalog] = React.useState<OptionsCatalog | null>(null);
  const catalogAbortRef = React.useRef<AbortController | null>(null);
  function stopKey(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  }
  // Live check of the output-schema text: empty means "no override";
  // otherwise it must parse as a JSON object (the harness schema subset is
  // object-rooted).
  const schemaTrimmed = schemaText.trim();
  let schemaError: string | null = null;
  if (schemaTrimmed.length > 0) {
    try {
      const parsed = JSON.parse(schemaTrimmed);
      if (
        parsed == null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        schemaError = 'The output schema must be a JSON object.';
      }
    } catch (err) {
      schemaError = 'Invalid JSON: ' + (err as Error).message;
    }
  }
  // Fetch the provider/model directory. `providerId === null` asks for the
  // deployment default (the first registered route); a specific id refetches
  // just that route's model list. Failures and aborts keep the fields
  // free-form — the harness accepts any adapter-resolvable id.
  function loadCatalog(providerId: string | null) {
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    const suffix =
      providerId !== null ? '?provider=' + encodeURIComponent(providerId) : '';
    fetch(ENDPOINT + '/options' + suffix, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const rec = (data ?? {}) as {
          ok?: unknown;
          providers?: unknown;
          models?: unknown;
          provider?: unknown;
        };
        if (rec.ok !== true) return;
        const providers: ProviderOption[] = Array.isArray(rec.providers)
          ? rec.providers
              .filter(
                (p): p is { id: string; name?: string } =>
                  p != null && typeof (p as { id?: unknown }).id === 'string',
              )
              .map((p) => ({
                id: p.id,
                name:
                  typeof p.name === 'string' && p.name.length > 0
                    ? p.name
                    : p.id,
              }))
          : [];
        const models: ModelOption[] = Array.isArray(rec.models)
          ? rec.models
              .filter(
                (m): m is { id: string; name?: string; description?: string } =>
                  m != null && typeof (m as { id?: unknown }).id === 'string',
              )
              .map((m) => ({
                id: m.id,
                name:
                  typeof m.name === 'string' && m.name.length > 0
                    ? m.name
                    : m.id,
                ...(typeof m.description === 'string' &&
                m.description.length > 0
                  ? { description: m.description }
                  : {}),
              }))
          : [];
        setCatalog({
          providers,
          models,
          provider: typeof rec.provider === 'string' ? rec.provider : '',
        });
      })
      .catch(() => {
        /* aborted or unavailable — free-form stays */
      });
  }
  // Load the provider/model directory on mount — for the agent's saved
  // provider when it has one, the deployment default route otherwise (the
  // inherited case). Aborted on unmount.
  React.useEffect(() => {
    loadCatalog(provider.length > 0 ? provider : null);
    return () => {
      catalogAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once from the mount-time agent
  }, []);
  function onProviderChange(next: string) {
    setProvider(next);
    // Model ids are provider-scoped: switching routes resets the model to the
    // inherited default. Always refetch, even if the first load failed.
    setModel('');
    loadCatalog(next.length > 0 ? next : null);
  }
  function field(
    label: string,
    value: string,
    set: (v: string) => void,
    title: string,
  ) {
    return (
      <div className='config-row'>
        <label>{label}</label>
        <input
          value={value}
          title={title}
          onChange={(e) => {
            set(e.target.value);
          }}
          onKeyDown={stopKey}
        />
      </div>
    );
  }
  // Assemble the persisted form state: the system prompt is the agent's
  // first-class field; settings keep only the construction knobs. Empty
  // fields are omitted entirely, so a cleared panel erases what it held.
  function assemble(): { systemPrompt?: string; settings?: AgentSettings } {
    const text = (s: string): string | undefined => {
      const t = s.trim();
      return t.length > 0 ? t : undefined;
    };
    const num = (s: string): number | undefined => {
      const t = s.trim();
      return /^\d+$/.test(t) ? parseInt(t, 10) : undefined;
    };
    const trimmedSystemPrompt = text(systemPrompt);
    const out: AgentSettings = {};
    const md = num(maxDepth);
    if (md !== undefined) out.maxDepth = md;
    const agentOptions: NonNullable<AgentSettings['agentOptions']> = {};
    const pr = text(provider);
    if (pr !== undefined) agentOptions.provider = pr;
    const mo = text(model);
    if (mo !== undefined) agentOptions.model = mo;
    const re = text(reasoningEffort);
    if (re !== undefined) agentOptions.reasoningEffort = re;
    const mt = num(maxTokens);
    if (mt !== undefined) agentOptions.maxTokens = mt;
    if (Object.keys(agentOptions).length > 0) out.agentOptions = agentOptions;
    const names = filterNames
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (names.length > 0)
      out.toolFilter =
        filterMode === 'deny' ? { deny: names } : { allow: names };
    if (schemaError === null && schemaTrimmed.length > 0)
      out.outputSchema = JSON.parse(schemaTrimmed);
    return {
      ...(trimmedSystemPrompt !== undefined
        ? { systemPrompt: trimmedSystemPrompt }
        : {}),
      ...(Object.keys(out).length > 0 ? { settings: out } : {}),
    };
  }
  const providers = catalog?.providers ?? [];
  const models = catalog?.models ?? [];
  return (
    <div
      className='pipeline-config-overlay'
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div className='pipeline-config'>
        <h3>Configure Agent</h3>
        <div className='config-columns'>
          <div className='config-col'>
            <div className='config-row'>
              <label>Name</label>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                onKeyDown={stopKey}
              />
            </div>
            <div className='config-row'>
              <label>Description</label>
              <input
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
                onKeyDown={stopKey}
              />
            </div>
            <div className='config-row'>
              <label>System prompt</label>
              <textarea
                value={systemPrompt}
                placeholder='system prompt for this agent — empty keeps the harness default'
                title="Replaces the persona slot (order 0) of the agent's system prompt for this agent alone — identity, policies, and tool explanations are inherited untouched"
                onChange={(e) => {
                  setSystemPrompt(e.target.value);
                }}
                onKeyDown={stopKey}
              />
            </div>
            <div className='config-row'>
              <label>Instructions</label>
              <textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value);
                }}
                onKeyDown={stopKey}
              />
            </div>
          </div>
          <div className='config-col config-col-settings'>
            <div className='config-row'>
              <label>Pause on output</label>
              <label
                className='config-check'
                title='Arm a breakpoint: the run pauses after this agent finishes, before any downstream agent starts — inspect the input and output, then Resume, Rerun, or Steer'
              >
                <input
                  type='checkbox'
                  checked={breakpoint}
                  onChange={(e) => {
                    setBreakpoint(e.target.checked);
                  }}
                  onKeyDown={stopKey}
                />
                <span>Pause the run after this agent finishes</span>
              </label>
              {breakpoint && schemaTrimmed.length > 0 ? (
                <div className='config-warning'>
                  A breakpointed agent runs as a continuable child, which cannot
                  produce structured output — the output schema below is ignored
                  for this agent.
                </div>
              ) : null}
            </div>
            <div className='config-grid'>
              <div className='config-row'>
                <label>Provider</label>
                <select
                  value={provider}
                  title="LLM provider route — Default inherits the parent Agent's provider"
                  onChange={(e) => {
                    onProviderChange(e.target.value);
                  }}
                  onKeyDown={stopKey}
                >
                  <option value=''>Default</option>
                  {providers.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                    >
                      {p.name}
                    </option>
                  ))}
                  {provider.length > 0 &&
                  !providers.some((p) => p.id === provider) ? (
                    <option value={provider}>{provider}</option>
                  ) : null}
                </select>
              </div>
              <div className='config-row'>
                <label>Model</label>
                <select
                  value={model}
                  title="Model advertised by the selected provider — Default inherits the parent Agent's model"
                  onChange={(e) => {
                    setModel(e.target.value);
                  }}
                  onKeyDown={stopKey}
                >
                  <option value=''>Default</option>
                  {models.map((m) => (
                    <option
                      key={m.id}
                      value={m.id}
                      title={m.description}
                    >
                      {m.name}
                    </option>
                  ))}
                  {model.length > 0 && !models.some((m) => m.id === model) ? (
                    <option value={model}>{model}</option>
                  ) : null}
                </select>
              </div>
              {field(
                'Reasoning effort',
                reasoningEffort,
                setReasoningEffort,
                'Adapter-owned reasoning-effort id (provider-specific)',
              )}
              {field(
                'Max output tokens',
                maxTokens,
                setMaxTokens,
                'Maximum output tokens per model request',
              )}
            </div>
            <div className='config-row'>
              <label>Tool filter</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <select
                  value={filterMode}
                  title='Whether the named tools are the only ones allowed or the ones removed'
                  aria-label='Tool filter mode'
                  style={{ width: 'auto', minWidth: '80px' }}
                  onChange={(e) => {
                    setFilterMode(e.target.value);
                  }}
                  onKeyDown={stopKey}
                >
                  <option value='allow'>allow</option>
                  <option value='deny'>deny</option>
                </select>
                <input
                  value={filterNames}
                  placeholder='tool names, comma-separated'
                  title="Global tool names, comma-separated (scoped to this child's creation window)"
                  onChange={(e) => {
                    setFilterNames(e.target.value);
                  }}
                  onKeyDown={stopKey}
                />
              </div>
            </div>
            {field(
              'Max delegation depth',
              maxDepth,
              setMaxDepth,
              'Absolute delegation-depth cap for this child',
            )}
            <div className='config-row'>
              <label>Output schema (JSON)</label>
              <textarea
                value={schemaText}
                placeholder='{ "type": "object", "properties": { … } }'
                title='Object-rooted JSON Schema — a successful run returns the matching structured value'
                style={{ minHeight: '56px' }}
                onChange={(e) => {
                  setSchemaText(e.target.value);
                }}
                onKeyDown={stopKey}
              />
              {schemaError ? (
                <div className='config-error'>{schemaError}</div>
              ) : null}
            </div>
          </div>
        </div>

        <div className='config-actions'>
          <button
            className='pipeline-btn'
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className='pipeline-btn'
            disabled={schemaError !== null}
            title={schemaError ?? undefined}
            onClick={() => {
              const assembled = assemble();
              onSave({
                id: agent.id,
                name,
                description,
                systemPrompt: assembled.systemPrompt,
                instructions,
                settings: assembled.settings,
                ...(breakpoint ? { breakpoint: true } : {}),
              });
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export { AgentConfigPanel };
