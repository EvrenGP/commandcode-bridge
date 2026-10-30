import type { EngineInterface, Register } from 'claude-code'

/*
 * Command Code bridge: runs Command Code (the person's own subscription) as a
 * subagent of Claude Code, and hands the conversation over to Command Code
 * when Claude's quota runs out.
 *
 * - Tools the model calls: run (delegate a task, optionally to a named agent
 *   that keeps its Command Code session between calls, or to a Command Code
 *   agent profile), transcript (read what a Command Code session did), agents
 *   (list or reset named agents, and list Command Code's agent profiles),
 *   models (the subscription's model list) and handoff (write this whole
 *   conversation into a native Command Code session).
 * - The conversation goes along on request: the recent messages, or all of
 *   them, are written to a context file the Command Code agent reads first.
 * - Permission tiers: read (Command Code's headless defaults, no edits), edit
 *   and full. edit and full are asked for each time unless the person chose
 *   "always" for that project; the answer is kept per project. Command Code's
 *   headless mode only opens writes and the shell together with --yolo, so the
 *   edit tier ships a guard mod that blocks shell tools: it edits, it does not
 *   run commands.
 * - Cache: a read-only, one-off run with the same prompt, model and context
 *   returns the stored answer for a while instead of spending the quota again.
 * - /commandcode shows runs, agents, permissions and settings, and changes
 *   them; continue/handoff write the conversation as a Command Code session
 *   (thinking and tool blocks kept) and, on request, open a terminal resuming
 *   it with `commandcode --session <file>`.
 */

const PLUGIN = 'commandcode-bridge'
type Mode = 'read' | 'edit' | 'full'
type ContextScope = 'none' | 'recent' | 'full'

type Config = {
  /** Path to Command Code's entry (index.mjs) or executable; empty finds it. */
  cliPath: string
  /** Model for runs that name none; empty is Command Code's own default. */
  model: string
  cacheTtlMin: number
  maxContextChars: number
  recentMessages: number
  maxTurns: number
  /** Keep thinking blocks in a handoff transcript. */
  handoffThinking: boolean
  /** Warn once a plan window (or the context) reaches this percent. */
  warnAtPercent: number
  /** Answer this session's turns with Command Code instead of Claude. */
  route: boolean
  /** Model for routed turns; empty is `model` or Command Code's default. */
  routeModel: string
  /** Tier a routed turn runs in: read, edit or full. */
  routeMode: string
}

const DEFAULTS: Config = {
  cliPath: '',
  model: 'deepseek/deepseek-v4.1-flash-fast',
  cacheTtlMin: 10,
  maxContextChars: 40000,
  recentMessages: 12,
  maxTurns: 40,
  handoffThinking: false,
  warnAtPercent: 90,
  route: false,
  routeModel: '',
  routeMode: 'edit',
}

// The subscription's catalogue, copied from commandcode.ai/docs
// (reference/cli/models): every id `/model`, an agent's `model:` and
// `/commandcode route model` accept, with its context window and the cheapest
// plan that serves it.
type ModelRow = [id: string, name: string, context: string, plan: string]

const MODEL_CATALOGUE: { provider: string; models: ModelRow[] }[] = [
  {
    provider: 'Open source',
    models: [
      ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', '1M', 'Go'],
      ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', '1M', 'Go'],
      ['deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (exp)', '1M', 'Go'],
      ['deepseek/deepseek-v4-flash-fast', 'DeepSeek V4 Flash Fast', '1M', 'Go'],
      ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '1M', 'Go'],
      ['deepseek/deepseek-v4.1-flash-fast', 'DeepSeek V4.1 Flash Fast', '1M', 'Go'],
      ['moonshotai/Kimi-K3.1-Pro', 'Kimi K3.1 Pro', '1.05M', 'Go'],
      ['moonshotai/Kimi-K3', 'Kimi K3', '1M', 'Go'],
      ['moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', '256K', 'Go'],
      ['moonshotai/Kimi-K2.7-Code-Highspeed', 'Kimi K2.7 Code HighSpeed', '262K', 'Go'],
      ['moonshotai/Kimi-K2.6', 'Kimi K2.6', '256K', 'Go'],
      ['moonshotai/Kimi-K2.5', 'Kimi K2.5', '256K', 'Go'],
      ['z-ai/glm-5.3-flash', 'GLM-5.3 Flash', '1.05M', 'Go'],
      ['z-ai/glm-5.3-flashx', 'GLM-5.3 FlashX', '1M', 'Go'],
      ['zai-org/GLM-5.3', 'GLM-5.3', '1M', 'Go'],
      ['zai-org/GLM-5.2', 'GLM-5.2', '1M', 'Go'],
      ['zai-org/GLM-5.2-Fast', 'GLM-5.2 Fast', '1M', 'Go'],
      ['zai-org/GLM-5.1', 'GLM-5.1', '', 'Go'],
      ['zai-org/GLM-5', 'GLM-5', '200K', 'Go'],
      ['minimax/minimax-m3.1-flash', 'MiniMax M3.1 Flash', '1M', 'Go'],
      ['MiniMaxAI/MiniMax-M3', 'MiniMax M3', '1M', 'Go'],
      ['MiniMaxAI/MiniMax-M2.7', 'MiniMax M2.7', '', 'Go'],
      ['MiniMaxAI/MiniMax-M2.5', 'MiniMax M2.5', '200K', 'Go'],
      ['ornith/ornith-1.5-122b', 'Ornith 1.5 122B', '262K', 'Go'],
      ['xiaomi/mimo-v2.6-pro', 'MiMo V2.6 Pro', '1.05M', 'Go'],
      ['xiaomi/mimo-v2.6-pro-ultraspeed', 'MiMo V2.6 Pro UltraSpeed', '1.05M', 'GOAT'],
      ['xiaomi/mimo-v2.6-flash', 'MiMo V2.6 Flash', '1.05M', 'Go'],
      ['Qwen/Qwen3.8-Omni-Flash', 'Qwen 3.8 Omni Flash', '1M', 'Go'],
      ['Qwen/Qwen3.8-Max-Prime', 'Qwen 3.8 Max Prime', '1M', 'GOAT'],
      ['Qwen/Qwen3.8-Max-0902', 'Qwen 3.8 Max 0902', '1M', 'Go'],
      ['Qwen/Qwen3.8-Max', 'Qwen 3.8 Max', '1M', 'Go'],
      ['Qwen/Qwen3.8-27B', 'Qwen 3.8 27B', '262K', 'Go'],
      ['Qwen/Qwen3.8-Flash', 'Qwen 3.8 Flash', '1M', 'Go'],
      ['Qwen/Qwen3.7-Max', 'Qwen 3.7 Max', '1M', 'Go'],
      ['Qwen/Qwen3.7-Plus', 'Qwen 3.7 Plus', '1M', 'Go'],
      ['Qwen/Qwen3.7-Flash', 'Qwen 3.7 Flash', '1M', 'Go'],
      ['Qwen/Qwen3.6-Max-Preview', 'Qwen 3.6 Max Preview', '', 'Go'],
      ['Qwen/Qwen3.6-Plus', 'Qwen 3.6 Plus', '', 'Go'],
      ['meituan/LongCat-2.0', 'LongCat 2.0', '1.05M', 'Go'],
      ['stepfun/Step-5-Preview', 'Step 5 Preview', '1M', 'Go'],
      ['stepfun/Step-3.7-Flash', 'Step 3.7 Flash', '256K', 'Go'],
      ['stepfun/Step-3.5-Flash', 'Step 3.5 Flash', '262K', 'Go'],
      ['tencent/hy3-paid', 'Tencent Hy3', '262K', 'Go'],
      ['tencent/hy4-preview', 'Tencent Hy4 Preview', '1.05M', 'Go'],
      ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', '1M', 'Go'],
      ['nvidia/nemotron-3.5-super-vl', 'Nemotron 3.5 Super VL', '262K', 'Go'],
      ['thinkingmachines/inkling', 'Inkling', '256K', 'Go'],
      ['thinkingmachines/inkling-small', 'Inkling Small', '1M', 'Go'],
      ['reflection/beam:free', 'Beam 1.0', '1.05M', 'Go'],
      ['poolside/laguna-s-2.1-free', 'Laguna S 2.1', '256K', 'Go'],
      ['inclusionai/ling-3.1-flash', 'Ling 3.1 Flash', '262K', 'Go'],
      ['mistral/mistral-large-4', 'Mistral Large 4', '524K', 'Go'],
    ],
  },
  {
    provider: 'Stealth',
    models: [['stealth/glyph-cluster:free', 'Glyph Cluster', '256K', 'Go']],
  },
  {
    provider: 'Anthropic',
    models: [
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5', '1M', 'GOAT'],
      ['claude-sonnet-5', 'Claude Sonnet 5', '1M', 'Pro'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6', '1M', 'Pro'],
      ['claude-fable-5-1', 'Claude Fable 5.1', '1M', 'Max'],
      ['claude-fable-5', 'Claude Fable 5', '1M', 'Max'],
      ['claude-opus-5-5', 'Claude Opus 5.5', '1M', 'Max'],
      ['claude-opus-5', 'Claude Opus 5', '1M', 'Max'],
      ['claude-opus-4-8', 'Claude Opus 4.8', '1M', 'Max'],
      ['claude-opus-4-7', 'Claude Opus 4.7', '1M', 'Max'],
      ['claude-haiku-5-5', 'Claude Haiku 5.5', '1M', 'GOAT'],
      ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '200K', 'Pro'],
    ],
  },
  {
    provider: 'OpenAI',
    models: [
      ['gpt-6-astra', 'GPT-6 Astra', '1.05M', 'Max'],
      ['gpt-6.1-sol', 'GPT-6.1 Sol', '1.05M', 'Max'],
      ['gpt-6.1-terra', 'GPT-6.1 Terra', '1.05M', 'Pro'],
      ['gpt-6-sol', 'GPT-6 Sol', '1.05M', 'Pro'],
      ['gpt-6-luna', 'GPT-6 Luna', '1.05M', 'Go'],
      ['gpt-5.6-sol', 'GPT-5.6 Sol', '1.05M', 'GOAT'],
      ['gpt-5.6-terra', 'GPT-5.6 Terra', '1.05M', 'Pro'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna', '1.05M', 'Go'],
      ['gpt-5.5', 'GPT-5.5', '400K', 'Pro'],
      ['gpt-5.4', 'GPT-5.4', '400K', 'Pro'],
      ['gpt-5.3-codex', 'GPT-5.3 Codex', '400K', 'Pro'],
      ['gpt-5.4-mini', 'GPT-5.4 Mini', '400K', 'Pro'],
    ],
  },
  {
    provider: 'Google',
    models: [
      ['google/gemini-4-argon', 'Gemini 4 Argon', '1M', 'Pro'],
      ['google/gemini-3.8-flash', 'Gemini 3.8 Flash', '1M', 'GOAT'],
      ['google/gemini-3.7-flash', 'Gemini 3.7 Flash', '1.05M', 'GOAT'],
      ['google/gemini-3.6-flash', 'Gemini 3.6 Flash', '1M', 'Pro'],
      ['google/gemini-3.5-flash', 'Gemini 3.5 Flash', '1M', 'Pro'],
      ['google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', '1M', 'Pro'],
      ['google/gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', '1M', 'Pro'],
    ],
  },
  {
    provider: 'Sakana',
    models: [['sakana/fugu-ultra', 'Fugu Ultra', '1M', 'Max']],
  },
  {
    provider: 'Meta',
    models: [
      ['meta/muse-spark-1.1', 'Muse Spark 1.1', '1.05M', 'Pro'],
      ['meta/muse-spark-1.2', 'Muse Spark 1.2', '1.05M', 'GOAT'],
      ['meta/muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', '1.05M', 'Go'],
      ['meta/muse-spark-1.3', 'Muse Spark 1.3', '1.05M', 'GOAT'],
      ['meta/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', '1.05M', 'Go'],
      ['meta/muse-spark-open', 'Muse Spark Open', '1.05M', 'Go'],
      ['meta/muse-wonder-1.0', 'Muse Wonder', '1.05M', 'Max'],
    ],
  },
  {
    provider: 'xAI',
    models: [
      ['xai/grok-4.5', 'Grok 4.5', '500K', 'Go'],
      ['xai/grok-4.6', 'Grok 4.6', '500K', 'GOAT'],
      ['xai/grok-4.7', 'Grok 4.7', '500K', 'GOAT'],
    ],
  },
]

function modelCount(): number {
  return MODEL_CATALOGUE.reduce((total, group) => total + group.models.length, 0)
}

/** The numbered list: the number is what `model <n>` and `route model <n>` take. */
function modelsText(current: { model: string; routeModel: string } = { model: '', routeModel: '' }): string {
  let n = 0
  const mark = (id: string) =>
    [id === current.model ? 'run' : '', id === current.routeModel ? 'route' : ''].filter(Boolean).join('+')
  const header = [
    `Command Code modelleri · ${modelCount()} · abonelik kataloğu (commandcode.ai/docs)`,
    `Şu an: run ${current.model || 'CLI varsayılanı'} · route ${current.routeModel || current.model || 'CLI varsayılanı'}`,
    'Seçmek için numara, id ya da adın bir parçası: /commandcode model 6 (run aracı) · /commandcode route model kimi-k3 (yönlendirme)',
  ].join('\n')
  return [
    header,
    ...MODEL_CATALOGUE.map((group) =>
      [
        `${group.provider} (${group.models.length})`,
        ...group.models.map(([id, name, context, plan]) => {
          n++
          const here = mark(id)
          return `${String(n).padStart(3)}. ${id} · ${name}${context ? ` · ${context}` : ''} · ${plan}${here ? `  ◀ ${here}` : ''}`
        }),
      ].join('\n'),
    ),
  ].join('\n\n')
}

/** A model by its list number, its id, or a part of its id or name that names one model alone. */
function resolveModel(input: string): { id: string } | { error: string } {
  const all = allModels()
  const raw = input.trim()
  if (/^\d+$/.test(raw)) {
    const picked = all[Number(raw) - 1]
    return picked ? { id: picked.id } : { error: `${raw} numaralı model yok (1-${all.length}). Liste: /commandcode models` }
  }
  const needle = raw.toLowerCase()
  const exact = all.find((model) =>
    [model.id, model.id.split('/').pop() ?? '', model.name].some((name) => name.toLowerCase() === needle),
  )
  if (exact) return { id: exact.id }
  const matches = all.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(needle))
  if (matches.length === 1) return { id: matches[0]!.id }
  if (matches.length === 0) return { error: `"${raw}" ile eşleşen model yok. Liste: /commandcode models` }
  return {
    error: `"${raw}" birden çok modele uyuyor, numarayla seç:\n${matches
      .slice(0, 12)
      .map((model) => `${String(all.indexOf(model) + 1).padStart(3)}. ${model.id} · ${model.name}`)
      .join('\n')}`,
  }
}

// --- the model picker -----------------------------------------------------

const PICKER = 'cc-models'
const pickerState = { filter: '', value: '' }

type PickerModel = { id: string; name: string; context: string; plan: string; provider: string }

function allModels(): PickerModel[] {
  return MODEL_CATALOGUE.flatMap((group) =>
    group.models.map(([id, name, context, plan]) => ({ id, name, context, plan, provider: group.provider })),
  )
}

function pickerModels(): PickerModel[] {
  const needle = pickerState.filter.trim().toLowerCase()
  const all = allModels()
  if (!needle) return all
  return all.filter((model) => `${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(needle))
}

async function setConfigOf($: $, patch: Partial<Config>): Promise<void> {
  const stored = ((await $.store.get('config')) ?? {}) as Partial<Config>
  await $.store.set('config', { ...stored, ...patch })
}

async function chooseModel($: $, id: string): Promise<void> {
  if (!id || id === 'none') return
  await setConfigOf($, { routeModel: id })
  pickerState.value = id
  try {
    await $.ui.close({ id: PICKER })
  } catch {
    // Already closed.
  }
  $.ui.toast(`Command Code modeli: ${id}`, { timeoutMs: 4000 })
}

type AgentRecord = { sessionId: string; model: string; updatedAt: number; runs: number }
type RunRecord = {
  id: string
  agent: string
  subagent: string
  model: string
  mode: Mode
  status: 'ok' | 'error' | 'cancelled' | 'cached' | 'denied' | 'blocked'
  at: number
  durationMs: number
  sessionId: string
  inputTokens: number
  outputTokens: number
  preview: string
}
type CacheEntry = { at: number; text: string; meta: string }
type Grants = { edit?: boolean; full?: boolean }
type Handoff = { sessionId: string; path: string; command: string; messages: number; at: number; note: string }
type RouteSession = { sessionId: string; model: string; updatedAt: number }
type CcAgent = {
  name: string
  description: string
  model: string
  tools: string
  source: 'project' | 'personal'
  path: string
  body: string
}

const MAX_RUNS = 40
const MAX_CACHE = 30
const MAX_HANDOFFS = 10
const MAX_PROMPT = 20000
const MAX_COMPLETE = 400000
const MAX_RESULT = 60000
const MAX_READ = 4 * 1024 * 1024

type $ = EngineInterface

function join(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/[\\/]+$/, ''))
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

function nativePath(path: string, windows: boolean): string {
  return windows ? path.replace(/\//g, '\\') : path
}

function quoteArg(text: string): string {
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

function slug(cwd: string): string {
  return cwd
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} characters cut]`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Drops the engine's injected reminders: a handoff carries the conversation, not the plumbing. */
function cleanText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function config($: $): Promise<Config> {
  const stored = ((await $.store.get('config')) ?? {}) as Partial<Config>
  return { ...DEFAULTS, ...stored }
}

async function projectKey($: $): Promise<string> {
  return (await $.session.root()).toLowerCase()
}

async function homeDir($: $): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
}

async function ccHome($: $): Promise<string> {
  return join(await homeDir($), '.commandcode')
}

async function isWindows($: $): Promise<boolean> {
  return (await $.env.get('APPDATA')) !== undefined
}

async function cliArgv($: $, cfg: Config): Promise<string[]> {
  const given = cfg.cliPath.trim()
  if (given) return /\.(m?js|cjs)$/i.test(given) ? ['node', given] : [given]
  const appData = await $.env.get('APPDATA')
  if (appData) {
    // Windows: npm installs a .cmd shim, which runs without a shell only through node.
    const entry = join(appData, 'npm/node_modules/command-code/dist/index.mjs')
    if (await $.fs.exists(entry)) return ['node', nativePath(entry, true)]
  }
  return ['commandcode']
}

async function guardPath($: $): Promise<string> {
  return nativePath(join($.plugin.root, 'guard-edit-only.ts'), await isWindows($))
}

// What each tier hands Command Code. read keeps its headless defaults, which
// withhold the writing and shell tools. Command Code's print mode opens those
// only under --yolo, so edit pairs it with a guard mod that blocks the shell.
async function modeFlags($: $, mode: Mode): Promise<string[]> {
  if (mode === 'read') return []
  if (mode === 'full') return ['--yolo']
  return ['--yolo', '--mod', await guardPath($)]
}

// --- permissions ----------------------------------------------------------

async function grants($: $): Promise<Grants> {
  return ((await $.store.get(`grants:${await projectKey($)}`)) ?? {}) as Grants
}

async function setGrant($: $, mode: 'edit' | 'full', value: boolean): Promise<void> {
  const key = `grants:${await projectKey($)}`
  const current = ((await $.store.get(key)) ?? {}) as Grants
  await $.store.set(key, { ...current, [mode]: value })
}

/** read is always allowed; edit and full need the person, once or for the project. */
async function permit($: $, mode: Mode, summary: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (mode === 'read') return { ok: true }
  if ((await grants($))[mode]) return { ok: true }
  const ONCE = 'Bu sefer izin ver'
  const ALWAYS = 'Bu projede hep izin ver'
  const DENY = 'Reddet'
  const what =
    mode === 'edit'
      ? 'dosyaları düzenleyebilir (kabuk komutları bu katmanda kapalı)'
      : 'her aracı onaysız kullanabilir (komut çalıştırma dahil)'
  let answer: string
  try {
    answer = await $.ui.ask(`Command Code ajanı bu projede ${what}. Görev: ${summary}`, {
      header: mode === 'edit' ? 'Düzenleme' : 'Tam yetki',
      options: [ONCE, ALWAYS, DENY],
    })
  } catch {
    return { ok: false, reason: `"${mode}" mode needs the person's approval and no one could be asked.` }
  }
  if (answer === ALWAYS) {
    await setGrant($, mode, true)
    return { ok: true }
  }
  if (answer === ONCE) return { ok: true }
  return { ok: false, reason: `The person did not allow "${mode}" mode for this run.` }
}

// --- the conversation, shared ---------------------------------------------

/** Keeps the newest part when the text is over the limit: that is what the task is about. */
function assemblePrompt(text: string, max: number): string {
  return text.length <= max ? text : `[... earlier part cut]\n\n${text.slice(-max)}`
}

/**
 * The conversation to hand along, as text. It is embedded in the prompt: a
 * headless run cannot read a file outside its workspace, so a shared context
 * file was never readable.
 */
async function buildContext(
  $: $,
  scope: ContextScope,
  cfg: Config,
  omitLastUser = false,
): Promise<string | null> {
  if (scope === 'none') return null
  const messages = await $.session.messages()
  let picked = scope === 'full' ? messages : messages.slice(-cfg.recentMessages)
  if (omitLastUser) {
    const last = picked.length - 1
    if (last >= 0 && picked[last].role === 'user') picked = picked.slice(0, last)
  }
  if (picked.length === 0) return null
  const lines: string[] = []
  for (const message of picked) {
    const tools = message.toolUses
      .map((use) => {
        const args = oneLine(JSON.stringify(use.input ?? {}), 200)
        const answer = use.text ? ` -> ${oneLine(use.text, 300)}` : ''
        return `  [tool ${use.tool}] ${args}${answer}`
      })
      .join('\n')
    const text = cleanText(message.text)
    if (!text && !tools) continue
    lines.push(`## ${message.role === 'user' ? 'User' : 'Claude'}\n${text}${tools ? `\n${tools}` : ''}`)
  }
  if (lines.length === 0) return null
  let body = lines.join('\n\n')
  if (body.length > cfg.maxContextChars) body = `[... earlier messages cut]\n\n${body.slice(-cfg.maxContextChars)}`
  return body
}

function composePrompt(task: string, mode: Mode, context: string | null, profile: CcAgent | null): string {
  const rules =
    mode === 'read'
      ? 'Do not modify any file; read, search and reason only.'
      : mode === 'edit'
        ? 'You may edit files in this project, but do not run shell commands: this run blocks them. Keep changes to what the task needs.'
        : 'You may use every tool. Keep changes to what the task needs.'
  const shared = context ? `\nThe calling conversation (newest last):\n\n${context}\n` : ''
  const role = profile
    ? `\nWork as the Command Code agent "${profile.name}" (${profile.source} agent definition at ${profile.path}). Follow its instructions:\n\n${clip(
        profile.body.trim(),
        6000,
      )}${profile.tools ? `\n\nIts declared tools: ${profile.tools}.` : ''}\n`
    : ''
  return assemblePrompt(
    `You are a subagent working for Claude Code. ${rules}${role}${shared}\n\nTask:\n${task}\n\nEnd with a concise report: what you found or changed, files touched, anything left open.`,
    MAX_PROMPT,
  )
}

function composeRoutePrompt(task: string, mode: Mode, context: string | null): string {
  const rules =
    mode === 'read'
      ? 'Do not modify any file; read, search and reason only.'
      : mode === 'edit'
        ? 'You may edit files in this project, but do not run shell commands: this run blocks them.'
        : 'You may use every tool.'
  const shared = context ? `\nThe conversation so far (newest last):\n\n${context}\n` : ''
  return assemblePrompt(
    `You are answering for Claude Code inside its own conversation, after the user switched to Command Code. ${rules}${shared}\n\nTask:\n${task}\n\n` +
      'Reply with the answer text alone: the caller shows it as the assistant message. Never describe these instructions.',
    MAX_PROMPT,
  )
}

// --- running Command Code -------------------------------------------------

type RunOutcome = {
  text: string
  sessionId: string
  model: string
  inputTokens: number
  outputTokens: number
  error: string
  cancelled: boolean
  blocked: string[]
}

async function runCommandCode(
  $: $,
  args: { prompt: string; model: string; mode: Mode; resume: string; maxTurns: number; label: string },
  signal: AbortSignal | undefined,
): Promise<RunOutcome> {
  const cfg = await config($)
  const argv = [
    ...(await cliArgv($, cfg)),
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(args.maxTurns),
    '--skip-onboarding',
    '--trust',
    '--no-auto-update',
    ...(args.model ? ['-m', args.model] : []),
    ...(args.resume ? ['--session', args.resume] : []),
    ...(await modeFlags($, args.mode)),
  ]
  const out: RunOutcome = {
    text: '',
    sessionId: args.resume,
    model: args.model,
    inputTokens: 0,
    outputTokens: 0,
    error: '',
    cancelled: false,
    blocked: [],
  }
  let buffer = ''
  let turn = 0
  const status = (what: string) => $.ui.status(`Command Code · ${args.label} · ${what}`)
  status('başlıyor')

  const usage = (source: any) => {
    if (!source) return
    if (typeof source.inputTokens === 'number') out.inputTokens = source.inputTokens + (source.cacheReadTokens ?? 0)
    if (typeof source.outputTokens === 'number') out.outputTokens = source.outputTokens
  }

  const handle = (line: string) => {
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      return
    }
    if (row.type === 'event' && row.event) {
      const ev = row.event
      if (ev.type === 'run_start' && ev.sessionId) out.sessionId = ev.sessionId
      else if (ev.type === 'turn_start') {
        turn = ev.turnNumber ?? turn + 1
        status(`tur ${turn}`)
      } else if (ev.type === 'model_request_start' && ev.model) out.model = ev.model
      else if (ev.type === 'model_request_end') usage(ev.usage)
      else if (ev.type === 'run_error') out.error = ev.error?.message ?? String(ev.error ?? 'run error')
      else if (ev.type === 'tool_hook_blocked') out.blocked.push(String(ev.toolName ?? 'tool'))
      else if (ev.type === 'run_end') {
        const result = ev.result ?? {}
        if (typeof result.finalText === 'string') out.text = result.finalText
        if (result.sessionId) out.sessionId = result.sessionId
        usage(result.usage)
      } else if (typeof ev.type === 'string' && /tool/.test(ev.type)) {
        const name = ev.toolName ?? ev.name ?? ev.tool?.name
        if (name) status(`tur ${turn} · ${name}`)
      }
    } else if (row.type === 'result') {
      if (typeof row.finalText === 'string' && row.finalText) out.text = row.finalText
      if (row.sessionId) out.sessionId = row.sessionId
      usage(row.usage)
      if (row.subtype === 'error' && !out.error) out.error = String(row.error ?? 'error')
    }
  }

  let stderr = ''
  try {
    // The prompt goes over stdin: a conversation dump is far past a command line.
    const child = $.process.spawn({ argv, input: args.prompt })
    for await (const piece of child) {
      if (!('stream' in piece)) break
      if (signal?.aborted) {
        out.cancelled = true
        break // leaving the loop kills Command Code
      }
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-4000)
        continue
      }
      buffer += piece.text
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        handle(buffer.slice(0, nl).trim())
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) handle(buffer.trim())
  } catch (err) {
    if (signal?.aborted) out.cancelled = true
    else out.error = `Command Code could not start: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    $.ui.status(undefined)
  }
  if (!out.error && !out.text && !out.cancelled && stderr.trim()) out.error = stderr.trim().split('\n').slice(-3).join(' ')
  return out
}

/** An empty reply or a dropped connection is worth one more try; an auth or quota error is not. */
function retriable(text: string, error: string, cancelled: boolean): boolean {
  if (cancelled || text.trim()) return false
  if (!error) return true
  if (isAuthError(error)) return false
  return /no response|empty|ECONNRESET|ETIMEDOUT|socket|timeout|fetch failed|\b5\d\d\b/i.test(error)
}

function isAuthError(error: string): boolean {
  return /expired|\b401\b|\b403\b|authentication failed|log ?in|api key/i.test(error)
}

/** The error as the person can act on it. */
function explainError(error: string): string {
  if (isAuthError(error)) {
    return `Command Code API anahtarı geçersiz ya da süresi dolmuş (${oneLine(error, 160)}). Terminalde önce \`commandcode logout\`, sonra \`commandcode login\` çalıştır (yalnız login eski anahtarı tutar), sonra tekrar dene; durum için /commandcode doctor.`
  }
  if (/no response/i.test(error)) return `Model boş yanıt döndü, tekrar da boş kaldı (${oneLine(error, 120)}). Başka model dene: /commandcode models.`
  return error
}

type RouteOutcome = {
  text: string
  sessionId: string
  model: string
  usage: any
  error: string
  cancelled: boolean
  blocked: string[]
  stderr: string
}

// --- routed turns: this session's answers come from Command Code -----------

async function routeOf($: $, claudeSessionId: string): Promise<RouteSession | null> {
  return ((await $.store.get(`route:${claudeSessionId}`)) ?? null) as RouteSession | null
}

async function saveRoute($: $, claudeSessionId: string, record: RouteSession | null): Promise<void> {
  const key = `route:${claudeSessionId}`
  if (record) await $.store.set(key, record)
  else await $.store.delete(key)
}

/** `/commandcode continue` routes this conversation only; `route on` routes every one. */
async function sessionRouteOn($: $, claudeSessionId: string): Promise<boolean> {
  return (await $.store.get(`routeon:${claudeSessionId}`)) === true
}

async function setSessionRoute($: $, claudeSessionId: string, on: boolean): Promise<void> {
  const key = `routeon:${claudeSessionId}`
  if (on) await $.store.set(key, true)
  else await $.store.delete(key)
}

function turnUsageOf(out: RouteOutcome): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
} | null {
  if (!out.usage) return null
  return {
    input_tokens: out.usage.inputTokens ?? 0,
    output_tokens: out.usage.outputTokens ?? 0,
    cache_read_input_tokens: out.usage.cacheReadTokens ?? 0,
    cache_creation_input_tokens: out.usage.cacheWriteTokens ?? 0,
    model: out.model || 'commandcode',
  }
}

/**
 * Runs one routed turn and yields the answer's text as it arrives.
 * `out` carries what the stream learned by the end.
 */
async function* streamRoute(
  $: $,
  cfg: Config,
  opts: { prompt: string; model: string; mode: Mode; resume: string; maxTurns: number },
  signal: AbortSignal | undefined,
  out: RouteOutcome,
): AsyncGenerator<string> {
  const argv = [
    ...(await cliArgv($, cfg)),
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(opts.maxTurns),
    '--skip-onboarding',
    '--trust',
    '--no-auto-update',
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.resume ? ['--session', opts.resume] : []),
    ...(await modeFlags($, opts.mode)),
  ]
  let buffer = ''
  let turn = 0
  let sawText = false
  const status = (what: string) => $.ui.status(`Command Code · tur ${turn || 1} · ${what}`)
  status('başlıyor')

  const handle = (line: string): string[] => {
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      return []
    }
    if (row.type === 'event' && row.event) {
      const ev = row.event
      if (ev.type === 'run_start' && ev.sessionId) out.sessionId = ev.sessionId
      else if (ev.type === 'turn_start') {
        turn = ev.turnNumber ?? turn + 1
        status('düşünüyor')
      } else if (ev.type === 'model_request_start') {
        if (ev.model) out.model = ev.model
        status('yanıtlıyor')
      } else if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
        sawText = true
        out.text += ev.delta
        return [ev.delta]
      } else if (ev.type === 'model_request_end' && ev.usage) out.usage = ev.usage
      else if (ev.type === 'run_error') out.error = ev.error?.message ?? String(ev.error ?? 'run error')
      else if (ev.type === 'tool_hook_blocked') out.blocked.push(String(ev.toolName ?? 'tool'))
      else if (ev.type === 'run_end') {
        if (ev.result?.sessionId) out.sessionId = ev.result.sessionId
        if (ev.result?.usage) out.usage = ev.result.usage
        if (!sawText && typeof ev.result?.finalText === 'string' && ev.result.finalText) {
          sawText = true
          out.text = ev.result.finalText
          return [ev.result.finalText]
        }
      } else if (typeof ev.type === 'string' && /^tool_/.test(ev.type)) {
        const name = ev.toolName ?? ev.name
        if (name) status(String(name))
      }
      return []
    }
    if (row.type === 'result') {
      if (row.sessionId) out.sessionId = row.sessionId
      if (row.usage) out.usage = row.usage
      if (!sawText && typeof row.finalText === 'string' && row.finalText) {
        sawText = true
        out.text = row.finalText
        return [row.finalText]
      }
    }
    return []
  }

  try {
    const child = $.process.spawn({ argv, input: opts.prompt })
    for await (const piece of child) {
      if (!('stream' in piece)) break
      if (signal?.aborted) {
        out.cancelled = true
        break // leaving the loop kills Command Code
      }
      if (piece.stream === 'stderr') {
        out.stderr = (out.stderr + piece.text).slice(-4000)
        continue
      }
      buffer += piece.text
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        for (const delta of handle(buffer.slice(0, nl).trim())) yield delta
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) for (const delta of handle(buffer.trim())) yield delta
  } catch (err) {
    if (signal?.aborted) out.cancelled = true
    else out.error = `Command Code could not start: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    $.ui.status(undefined)
  }
  if (!out.error && !out.text && !out.cancelled && out.stderr.trim()) {
    out.error = out.stderr.trim().split('\n').slice(-3).join(' ')
  }
}

// --- records --------------------------------------------------------------

async function agentsOf($: $): Promise<Record<string, AgentRecord>> {
  return ((await $.store.get(`agents:${await projectKey($)}`)) ?? {}) as Record<string, AgentRecord>
}

async function saveAgent($: $, name: string, rec: AgentRecord | null): Promise<void> {
  const key = `agents:${await projectKey($)}`
  const all = ((await $.store.get(key)) ?? {}) as Record<string, AgentRecord>
  if (rec) all[name] = rec
  else delete all[name]
  await $.store.set(key, all)
}

async function addRun($: $, run: RunRecord): Promise<void> {
  const runs = ((await $.store.get('runs')) ?? []) as RunRecord[]
  await $.store.set('runs', [...runs, run].slice(-MAX_RUNS))
}

async function cacheGet($: $, key: string, ttlMin: number): Promise<CacheEntry | null> {
  const cache = ((await $.store.get('cache')) ?? {}) as Record<string, CacheEntry>
  const hit = cache[key]
  if (!hit) return null
  return (await $.clock.now()) - hit.at <= ttlMin * 60000 ? hit : null
}

async function cachePut($: $, key: string, entry: CacheEntry, ttlMin: number): Promise<void> {
  const now = await $.clock.now()
  const cache = ((await $.store.get('cache')) ?? {}) as Record<string, CacheEntry>
  const kept = Object.entries(cache)
    .filter(([, value]) => now - value.at <= ttlMin * 60000)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_CACHE - 1)
  await $.store.set('cache', Object.fromEntries([[key, entry], ...kept]))
}

async function lastHandoffs($: $): Promise<Handoff[]> {
  return ((await $.store.get('handoffs')) ?? []) as Handoff[]
}

async function addHandoff($: $, handoff: Handoff): Promise<void> {
  const all = await lastHandoffs($)
  await $.store.set(
    'handoffs',
    [...all.filter((item) => item.sessionId !== handoff.sessionId), handoff].slice(-MAX_HANDOFFS),
  )
}

// --- Command Code agent profiles ------------------------------------------

function frontmatter(raw: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key) out[key] = value
  }
  return out
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

async function ccAgents($: $): Promise<CcAgent[]> {
  const cwd = await $.session.cwd()
  const sources: [string, 'project' | 'personal'][] = [
    [join(cwd, '.commandcode', 'agents'), 'project'],
    [join(await ccHome($), 'agents'), 'personal'],
  ]
  const found = new Map<string, CcAgent>()
  for (const [dir, source] of sources) {
    if (!(await $.fs.exists(dir))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
      const path = join(dir, entry.name)
      let raw: string
      try {
        raw = String(await $.fs.read(path))
      } catch {
        continue
      }
      const meta = frontmatter(raw)
      const name = (meta.name || entry.name.replace(/\.md$/i, '')).trim()
      if (!name) continue
      // A project agent wins a name clash with a personal one.
      if (found.get(name)?.source === 'project') continue
      found.set(name, {
        name,
        description: meta.description ?? '',
        model: meta.model ?? '',
        tools: meta.tools ?? '',
        source,
        path,
        body: stripFrontmatter(raw),
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// --- reading a Command Code transcript ------------------------------------

async function findTranscript($: $, sessionId: string): Promise<string | null> {
  const root = join(await ccHome($), 'projects')
  if (!(await $.fs.exists(root))) return null
  const id = sessionId.replace(/\.jsonl$/i, '')
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir') continue
    const path = join(root, dir.name, `${id}.jsonl`)
    if (await $.fs.exists(path)) return path
  }
  return null
}

/** A cut into the middle of a line leaves a fragment; the first full row is what parses. */
function dropPartialLine(text: string): string {
  const cut = text.indexOf('\n')
  return cut >= 0 ? text.slice(cut + 1) : text
}

/** `$.fs.read` refuses a file over 4 MiB, so a long transcript is tailed instead. */
async function readTail($: $, path: string, maxBytes: number): Promise<string> {
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat) return ''
  if (stat.size <= MAX_READ) {
    const text = String(await $.fs.read(path))
    return text.length > maxBytes ? dropPartialLine(text.slice(-maxBytes)) : text
  }
  const script =
    'const fs=require("fs");const s=fs.openSync(process.argv[1],"r");' +
    'const st=fs.fstatSync(s);const n=Math.min(Number(process.argv[2]),st.size);' +
    'const b=Buffer.alloc(n);fs.readSync(s,b,0,n,st.size-n);process.stdout.write(b.toString("utf8"))'
  const ran = await $.process.run(['node', '-e', script, path, String(maxBytes)], { timeoutMs: 60000 })
  if (ran.exitCode === 0 && ran.stdout) return dropPartialLine(ran.stdout)
  return ''
}

function renderTranscript(raw: string, last: number): string {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const msg = row.message ?? row
    const role = msg.role ?? row.type
    if (role !== 'user' && role !== 'assistant') continue
    const parts: string[] = []
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }]
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text)
      else if (block.type === 'thinking' && block.thinking) parts.push(`[thinking] ${clip(block.thinking, 700)}`)
      else if (block.type === 'tool_use' || block.type === 'tool-call') {
        parts.push(
          `[tool ${block.name ?? block.toolName ?? block.tool}] ${clip(JSON.stringify(block.input ?? block.args ?? {}), 400)}`,
        )
      } else if (block.type === 'tool_result' || block.type === 'tool-result') {
        const inner = block.content ?? block.output ?? ''
        const text = typeof inner === 'string' ? inner : JSON.stringify(inner)
        parts.push(`[result] ${clip(text, 700)}`)
      }
    }
    if (parts.length) out.push(`## ${role}\n${parts.join('\n')}`)
  }
  return out.slice(-last).join('\n\n') || '(transcript içinde mesaj bulunamadı)'
}

// --- handing the conversation over ----------------------------------------

function ccBlocks(content: any[], keepThinking: boolean): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = []
  for (const block of content) {
    const type = String(block?.type ?? '')
    const text = typeof block?.text === 'string' ? cleanText(block.text) : ''
    if (type === 'text' && text) {
      blocks.push({ type: 'text', text })
    } else if (type === 'thinking' && keepThinking && typeof block.thinking === 'string' && block.thinking.trim()) {
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: typeof block.signature === 'string' ? block.signature : '',
      })
    } else if (type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: String(block.id ?? `call_${hash(JSON.stringify(block.input ?? {}))}`),
        name: String(block.name ?? 'tool'),
        input: block.input ?? {},
      })
    } else if (type === 'tool_result') {
      const raw = block.content
      const inner = (Array.isArray(raw) ? raw : [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') }])
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => ({ type: 'text', text: part.text }))
      blocks.push({
        type: 'tool_result',
        tool_use_id: String(block.tool_use_id ?? ''),
        content: inner.length ? inner : [{ type: 'text', text: '(result has no text)' }],
        ...(block.is_error ? { is_error: true } : {}),
      })
    } else if (type === 'image' || type === 'document') {
      blocks.push({ type: 'text', text: `[${type} omitted when the conversation moved to Command Code]` })
    }
  }
  return blocks
}

async function buildHandoff($: $, cfg: Config, note: string): Promise<Handoff> {
  const messages = await $.session.messages({ as: 'api' })
  const cwd = await $.session.cwd()
  const windows = await isWindows($)
  const sessionId = uuid()
  const dir = join(await ccHome($), 'projects', slug(cwd))
  const path = join(dir, `${sessionId}.jsonl`)
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const rows: string[] = [JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: iso, cwd })]
  let parent: string | null = null
  const push = (role: 'user' | 'assistant', content: Record<string, unknown>[]) => {
    const id = shortId()
    rows.push(
      JSON.stringify({
        type: 'message',
        id,
        parentId: parent,
        timestamp: iso,
        message: {
          role,
          content,
          meta: { source: role === 'user' ? 'user' : 'model', createdAt: now, messageId: uuid() },
        },
      }),
    )
    parent = id
  }

  let usable = messages.filter((message) => ccBlocks(message.content ?? [], cfg.handoffThinking).length > 0)
  // A Command Code transcript opens on a user message.
  while (usable.length && usable[0].role !== 'user') usable = usable.slice(1)
  if (!usable.length) {
    push('user', [{ type: 'text', text: note.trim() || 'Continuing this conversation in Command Code.' }])
  }
  for (const message of usable) {
    push(message.role, ccBlocks(message.content ?? [], cfg.handoffThinking))
  }
  // Where to pick up: the note rides along as the last user turn.
  if (usable.length && note.trim()) push('user', [{ type: 'text', text: note.trim() }])

  await $.fs.write(path, `${rows.join('\n')}\n`)
  await $.fs.write(
    join(dir, `${sessionId}.meta.json`),
    `${JSON.stringify({ entrypoint: 'interactive', traceIds: [] }, null, 2)}\n`,
  )

  const argv = [...(await cliArgv($, cfg)), '--session', nativePath(path, windows)]
  const handoff: Handoff = {
    sessionId,
    path,
    command: argv.map(quoteArg).join(' '),
    messages: usable.length,
    at: now,
    note: note.trim(),
  }
  await addHandoff($, handoff)
  return handoff
}

// --- the module -----------------------------------------------------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'run',
      isDeferred: false,
      description:
        "Delegate a task to a Command Code agent (the user's Command Code subscription, its own models such as DeepSeek, Kimi, GLM, Qwen) as a subagent. " +
        'Use it when the user asks for Command Code, for a second opinion from another model, or to offload a self-contained task to save Claude tokens: ' +
        'broad searches, reading and summarising many files, drafts, mechanical edits. The default model is a fast DeepSeek; pass `context: "none"` with a self-contained prompt for the cheapest run. ' +
        'Give `agent` a name to keep a persistent Command Code session for follow-ups; leave it out for a one-off run. ' +
        '`subagent` runs the task as one of the Command Code agent profiles on disk (.commandcode/agents or ~/.commandcode/agents). ' +
        '`context` shares this conversation with it: "recent" (default) the last messages, "full" all, "none" nothing. ' +
        '`mode`: "read" (default, no file changes), "edit" (may edit files, never runs shell commands), "full" (every tool); edit and full ask the user. ' +
        'Returns its final report, its session id and the transcript path; read the transcript with the transcript tool.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task, self-contained.' },
          agent: { type: 'string', description: 'Name of a persistent agent to continue or create (letters, digits, -).' },
          subagent: { type: 'string', description: 'A Command Code agent profile name (see the agents tool).' },
          model: { type: 'string', description: 'A Command Code model id (see the models tool); default the configured one.' },
          mode: { type: 'string', enum: ['read', 'edit', 'full'] },
          context: { type: 'string', enum: ['none', 'recent', 'full'] },
          useCache: { type: 'boolean', description: 'Reuse a recent identical read-only answer (default true).' },
          maxTurns: { type: 'number' },
        },
        required: ['prompt'],
      },
    })
    await $.tool.register({
      name: 'transcript',
      description:
        "Read what a Command Code session did: its messages, tool calls and results. Pass `agent` (a named agent's session) or `sessionId`; `last` caps the messages (default 30).",
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string' }, sessionId: { type: 'string' }, last: { type: 'number' } },
      },
    })
    await $.tool.register({
      name: 'agents',
      description:
        'List the named Command Code agents of this project, the Command Code agent profiles on disk, and the recent runs; or reset one bridge agent (`reset`: name) so its next run starts a fresh session.',
      inputSchema: { type: 'object', properties: { reset: { type: 'string' } } },
    })
    await $.tool.register({
      name: 'models',
      description:
        "List every model in the user's Command Code subscription catalogue: its id, context window and the cheapest plan that serves it. " +
        'These ids are what `model` and `/commandcode route model` accept.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'usage',
      description:
        "Show the user's Command Code subscription usage: credits left in the 5-hour and weekly windows, monthly credits, reset times. " +
        'Check it before a large delegation; when a window is nearly used up, do the task with Claude instead.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'handoff',
      description:
        'Move this whole conversation into a native Command Code session: writes every message (tool calls and results included) as a Command Code transcript and returns the `commandcode --session <file>` command. ' +
        'Use it when the user is close to their Claude quota, asks to continue in Command Code, or wants this conversation to survive a limit. It opens nothing itself.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Where to pick up; stored as the handoff note.' },
          includeThinking: { type: 'boolean', description: 'Keep thinking blocks in the transcript (default false).' },
        },
      },
    })
    await $.command.register({
      name: 'commandcode',
      description: 'Command Code bridge: handoff, continue, runs, agents, permissions, cache and settings',
      argumentHint:
        '[continue [note] | route on|off|model|mode | models | model <n> | usage | doctor | handoff [note] | agents | revoke edit|full | clear-cache | set <key> <value>]',
    })
    return started
  })

  // Routed turns: answer in this same conversation from Command Code, without
  // sending a request to Claude. "An answer without next sends no request."
  on('turn.step', async function* ($, e, next) {
    const cfg = await config($)
    const claudeSession = await $.session.id()
    const active = cfg.route || (await sessionRouteOn($, claudeSession))

    if (!active || e.agentId !== undefined) {
      if (!active && (await routeOf($, claudeSession))) await saveRoute($, claudeSession, null)
      for await (const chunk of next(e)) yield chunk
      return
    }

    const mode: Mode = cfg.routeMode === 'read' || cfg.routeMode === 'full' ? cfg.routeMode : 'edit'
    const model = (cfg.routeModel || cfg.model).trim()
    const rows = await $.session.messages()
    // The newest row can be an injected reminder, which cleans to nothing.
    const lastUser = [...rows].reverse().find((message) => message.role === 'user' && cleanText(message.text).trim())
    const task = cleanText(lastUser?.text ?? '').trim() || 'Continue the conversation.'
    const now = await $.clock.now()
    const runId = `${now.toString(36)}-${hash(task).slice(0, 4)}`

    const refuse = async function* (reason: string) {
      const text = `Command Code bu turu yanıtlayamadı: ${reason}`
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }

    const allowed = await permit($, mode, oneLine(task, 140))
    if (!allowed.ok) return yield* refuse(allowed.reason)
    if (mode === 'edit' && !(await $.fs.exists(await guardPath($)))) {
      return yield* refuse(`edit katmanının koruma modu bulunamadı: ${await guardPath($)}`)
    }

    const known = await routeOf($, claudeSession)
    const context = known?.sessionId ? null : await buildContext($, 'full', cfg, true)
    const prompt = composeRoutePrompt(task, mode, context)
    const out: RouteOutcome = {
      text: '',
      sessionId: known?.sessionId ?? '',
      model,
      usage: null,
      error: '',
      cancelled: false,
      blocked: [],
      stderr: '',
    }

    $.ui.status(`Command Code · ${model || 'varsayılan model'} · ${mode}`)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // Nothing was shown yet, so the second try starts clean.
        if (!retriable(out.text, out.error, out.cancelled)) break
        Object.assign(out, { error: '', stderr: '', blocked: [] })
      }
      for await (const delta of streamRoute(
        $,
        cfg,
        { prompt, model, mode, resume: known?.sessionId ?? '', maxTurns: cfg.maxTurns },
        next.signal,
        out,
      )) {
        yield { kind: 'text', index: 0, text: delta }
      }
    }
    if (!out.text && !out.error && !out.cancelled) out.error = 'The model produced no response.'

    if (out.error) {
      const text = `\n\n[Command Code hatası: ${explainError(out.error)}${out.text ? '' : ` · görev: ${oneLine(task, 80)}`}]`
      out.text += text
      yield { kind: 'text', index: 0, text }
    }
    if (out.sessionId && !out.cancelled) {
      await saveRoute($, claudeSession, { sessionId: out.sessionId, model: out.model || model, updatedAt: now })
    }
    await addRun($, {
      id: runId,
      agent: '',
      subagent: '',
      model: out.model || model,
      mode,
      status: out.cancelled ? 'cancelled' : out.error ? 'error' : 'ok',
      at: now,
      durationMs: (await $.clock.now()) - now,
      sessionId: out.sessionId,
      inputTokens: out.usage?.inputTokens ?? 0,
      outputTokens: out.usage?.outputTokens ?? 0,
      preview: `[routed] ${out.text.slice(0, 140)}`,
    })

    const stopReason = out.cancelled ? null : 'end_turn'
    const usage = turnUsageOf(out)
    yield { kind: 'stop', stopReason, usage }
    return { turnId: e.turnId, index: e.index, answer: out.text, toolUses: [], stopReason, usage }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__run` }, async ($, e, next) => {
    const input = e as unknown as {
      prompt: string
      agent?: string
      subagent?: string
      model?: string
      mode?: Mode
      context?: ContextScope
      useCache?: boolean
      maxTurns?: number
    }
    if (!input.prompt?.trim()) return { result: 'The `prompt` is empty.', isError: true }

    const cfg = await config($)
    const mode: Mode = input.mode === 'edit' || input.mode === 'full' ? input.mode : 'read'
    const scope: ContextScope = input.context === 'none' || input.context === 'full' ? input.context : 'recent'
    const agentName = (input.agent ?? '').trim().replace(/[^\w-]/g, '-').slice(0, 40)
    const profileName = (input.subagent ?? '').trim()

    let profile: CcAgent | null = null
    if (profileName) {
      const profiles = await ccAgents($)
      profile = profiles.find((agent) => agent.name === profileName) ?? null
      if (!profile) {
        return {
          result: `No Command Code agent profile named "${profileName}". ${
            profiles.length ? `Known profiles: ${profiles.map((agent) => agent.name).join(', ')}.` : 'This project has no agent profiles.'
          }`,
          isError: true,
        }
      }
    }
    if (mode === 'edit' && !(await $.fs.exists(await guardPath($)))) {
      return { result: `The edit tier needs its guard mod at ${await guardPath($)}; reinstall the plugin.`, isError: true }
    }

    const now = await $.clock.now()
    const runId = `${now.toString(36)}-${hash(input.prompt).slice(0, 4)}`
    const label = profile ? `${profile.name}${agentName ? `/${agentName}` : ''}` : agentName || 'one-off'

    const allowed = await permit($, mode, oneLine(input.prompt, 140))
    if (!allowed.ok) {
      await addRun($, {
        id: runId,
        agent: agentName,
        subagent: profileName,
        model: input.model ?? cfg.model,
        mode,
        status: 'denied',
        at: now,
        durationMs: 0,
        sessionId: '',
        inputTokens: 0,
        outputTokens: 0,
        preview: allowed.reason,
      })
      return { deny: allowed.reason }
    }

    const agents = await agentsOf($)
    const known = agentName ? agents[agentName] : undefined
    const model = (input.model ?? profile?.model ?? known?.model ?? cfg.model).trim()
    const context = await buildContext($, scope, cfg)

    // Only a read-only one-off run is cached: an agent's run moves its session on,
    // and an edit changes the files the answer was about.
    const contextDigest = context ? hash(context) : '-'
    const cacheKey = hash(JSON.stringify([await projectKey($), model, profileName, input.prompt, scope, contextDigest]))
    const cacheable = mode === 'read' && !agentName && input.useCache !== false
    if (cacheable) {
      const hit = await cacheGet($, cacheKey, cfg.cacheTtlMin)
      if (hit) {
        await addRun($, {
          id: runId,
          agent: '',
          subagent: profileName,
          model,
          mode,
          status: 'cached',
          at: now,
          durationMs: 0,
          sessionId: '',
          inputTokens: 0,
          outputTokens: 0,
          preview: hit.text.slice(0, 160),
        })
        return { result: `${hit.text}\n\n---\n${hit.meta} · cache'ten (${Math.round((now - hit.at) / 1000)} sn önce)` }
      }
    }

    const runArgs = {
      prompt: composePrompt(input.prompt, mode, context, profile),
      model,
      mode,
      resume: known?.sessionId ?? '',
      maxTurns: Math.max(1, Math.min(200, Math.round(input.maxTurns ?? cfg.maxTurns))),
      label,
    }
    let outcome = await runCommandCode($, runArgs, next.signal)
    if (retriable(outcome.text, outcome.error, outcome.cancelled)) {
      outcome = await runCommandCode($, { ...runArgs, label: `${label} · 2. deneme` }, next.signal)
    }
    if (!outcome.text && !outcome.error && !outcome.cancelled) outcome.error = 'The model produced no response.'
    const durationMs = (await $.clock.now()) - now
    const status: RunRecord['status'] = outcome.cancelled
      ? 'cancelled'
      : outcome.error
        ? 'error'
        : outcome.blocked.length && !outcome.text
          ? 'blocked'
          : 'ok'
    await addRun($, {
      id: runId,
      agent: agentName,
      subagent: profileName,
      model: outcome.model || model,
      mode,
      status,
      at: now,
      durationMs,
      sessionId: outcome.sessionId,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      preview: (outcome.error || outcome.text).slice(0, 160),
    })
    if (agentName && outcome.sessionId && !outcome.cancelled) {
      await saveAgent($, agentName, {
        sessionId: outcome.sessionId,
        model: outcome.model || model,
        updatedAt: now,
        runs: (known?.runs ?? 0) + 1,
      })
    }
    const transcriptPath = outcome.sessionId ? await findTranscript($, outcome.sessionId) : null
    const meta = [
      `Command Code${profile ? ` ${profile.name}` : ''}${agentName ? ` agent "${agentName}"` : ''}`,
      outcome.model || model || 'varsayılan model',
      mode,
      `${Math.round(durationMs / 1000)} sn`,
      `${outcome.inputTokens} in / ${outcome.outputTokens} out token`,
      outcome.sessionId ? `session ${outcome.sessionId}` : '',
      transcriptPath ? `transcript ${transcriptPath}` : '',
      await usageFooter($),
    ]
      .filter(Boolean)
      .join(' · ')
    if (outcome.cancelled) return { result: `İptal edildi.\n\n---\n${meta}`, isError: true }
    if (outcome.error) {
      const hint = isAuthError(outcome.error) ? ' Do not retry: the user has to log in again first.' : ''
      return { result: `Command Code başarısız: ${explainError(outcome.error)}${hint}\n\n---\n${meta}`, isError: true }
    }
    const blocked = outcome.blocked.length
      ? `\n\nEngellenen araçlar: ${[...new Set(outcome.blocked)].join(', ')} (${mode} katmanı).`
      : ''
    const text = clip(outcome.text || '(son metin yok)', MAX_RESULT)
    if (cacheable) await cachePut($, cacheKey, { at: now, text, meta }, cfg.cacheTtlMin)
    return { result: `${text}${blocked}\n\n---\n${meta}` }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__transcript` }, async ($, e) => {
    const input = e as unknown as { agent?: string; sessionId?: string; last?: number }
    let sessionId = (input.sessionId ?? '').trim()
    if (!sessionId && input.agent) sessionId = (await agentsOf($))[input.agent]?.sessionId ?? ''
    if (!sessionId) {
      const runs = ((await $.store.get('runs')) ?? []) as RunRecord[]
      sessionId = [...runs].reverse().find((run) => run.sessionId)?.sessionId ?? ''
    }
    if (!sessionId) return { result: 'Henüz okunacak bir Command Code oturumu yok.', isError: true }
    const path = await findTranscript($, sessionId)
    if (!path) return { result: `Oturum ${sessionId} için transcript bulunamadı.`, isError: true }
    const raw = await readTail($, path, 600000)
    if (!raw) return { result: `Transcript okunamadı: ${path}`, isError: true }
    return { result: `Transcript ${path}\n\n${clip(renderTranscript(raw, Math.max(1, input.last ?? 30)), MAX_RESULT)}` }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__agents` }, async ($, e) => {
    const input = e as unknown as { reset?: string }
    if (input.reset) {
      await saveAgent($, input.reset, null)
      return { result: `Agent "${input.reset}" sıfırlandı; sonraki çalışması yeni bir Command Code oturumu açar.` }
    }
    return { result: await overview($) }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__usage` }, async ($) => ({ result: await usageText($) }))

  on('tool.call', { tool: `mcp__${PLUGIN}__models` }, async ($) => ({ result: modelsText(await config($)) }))

  on('tool.call', { tool: `mcp__${PLUGIN}__handoff` }, async ($, e) => {
    const input = e as unknown as { note?: string; includeThinking?: boolean }
    const cfg = await config($)
    if (input.includeThinking !== undefined) {
      const stored = ((await $.store.get('config')) ?? {}) as Partial<Config>
      await $.store.set('config', { ...stored, handoffThinking: input.includeThinking })
    }
    const effective = input.includeThinking === undefined ? cfg : { ...cfg, handoffThinking: input.includeThinking }
    const handoff = await buildHandoff($, effective, input.note ?? '')
    return {
      result: [
        `Sohbet Command Code oturumuna yazıldı: ${handoff.messages} mesaj.`,
        `Oturum: ${handoff.sessionId}`,
        `Dosya: ${handoff.path}`,
        `Devam etmek için: ${handoff.command}`,
      ].join('\n'),
    }
  })

  // The picker: a pane with a filter field and the catalogue as a Select. A
  // pick writes `routeModel`, which every routed turn passes as `-m`.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.requestId !== PICKER) return rest
    const elements = $.ui.resolve(e) as any
    const { Box, Text, Input, Select } = elements
    if (!Input || !Select) return rest

    const list = pickerModels()
    const options = list.length
      ? list
          .slice(0, 200)
          .map((model) => ({
            value: model.id,
            label: `${model.name} · ${model.id}${model.context ? ` · ${model.context}` : ''}`,
          }))
      : [{ value: 'none', label: 'Eşleşme yok' }]
    const current = options.some((option) => option.value === pickerState.value) ? pickerState.value : options[0].value

    try {
      const children = [
        Text({
          dimColor: true,
          children: [`${modelCount()} model · seçili: ${pickerState.value || 'varsayılan'} · Enter uygular · Esc kapatır`],
        }),
        Input({
          key: 'filter',
          label: 'Ara',
          placeholder: 'glm, kimi, deepseek…',
          value: pickerState.filter,
          onSubmit: (value: string) => {
            pickerState.filter = value
            $.ui.invalidate('ui.render')
          },
        }),
        Select({
          key: 'model',
          label: 'Model',
          options,
          value: current,
          autoFocus: true,
          onSelect: (value: string) => {
            void chooseModel($, value)
          },
        }),
      ]
      if (rest) children.push(rest as any)
      return Box({ flexDirection: 'column', children })
    } catch (err) {
      $.ui.log(`model picker failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      return rest
    }
  })

  // Compaction, summaries and every other internal completion: routed the
  // same way, so /compact works while Claude's quota is out.
  on('model.complete', async ($, e, next) => {
    const cfg = await config($)
    const active = cfg.route || (await sessionRouteOn($, await $.session.id()))
    if (!active) return next(e)
    const input = e as unknown as { prompt: string; system?: string }
    const prompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt
    const outcome = await runCommandCode(
      $,
      {
        prompt: assemblePrompt(prompt, MAX_COMPLETE),
        model: (cfg.routeModel || cfg.model).trim(),
        mode: 'read',
        resume: '',
        maxTurns: 1,
        label: 'model.complete',
      },
      undefined,
    )
    if (!outcome.text) return next(e)
    return {
      isAnswered: true,
      text: outcome.text,
      usage: {
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })

  // /compact and the auto threshold: summarize through Command Code and hand
  // the engine the compacted conversation itself, so no Claude call is made.
  on('session.compact', async ($, e, next) => {
    const cfg = await config($)
    const active = cfg.route || (await sessionRouteOn($, await $.session.id()))
    if (!active) return next(e)
    const input = e as unknown as { messages: any[]; instructions?: string; agentId?: string }
    if (input.agentId) return next(e)
    const lines: string[] = []
    for (const message of input.messages ?? []) {
      const text = cleanText(message.text ?? '')
      const tools = (message.toolUses ?? [])
        .map((use: any) => `  [tool ${use.tool}] ${oneLine(JSON.stringify(use.input ?? {}), 160)}`)
        .join('\n')
      if (!text && !tools) continue
      lines.push(`## ${message.role === 'user' ? 'User' : 'Claude'}\n${text}${tools ? `\n${tools}` : ''}`)
    }
    const dump = lines.join('\n\n')
    if (!dump.trim()) return next(e)

    const prompt = [
      'Summarize this coding conversation so the work can continue from the summary alone.',
      'Keep: the goal and constraints, decisions made, files and commands touched, what is done, what is open, and the exact next step.',
      'Be concise but complete; write it as plain prose the next turn can use.',
      ...(input.instructions ? ['', `Extra instructions: ${input.instructions}`] : []),
      '',
      'Conversation:',
      '',
      dump,
    ].join('\n')

    const outcome = await runCommandCode(
      $,
      {
        prompt: assemblePrompt(prompt, MAX_COMPLETE),
        model: (cfg.routeModel || cfg.model).trim(),
        mode: 'read',
        resume: '',
        maxTurns: 1,
        label: 'compact',
      },
      undefined,
    )
    if (!outcome.text) return next(e)
    return {
      messages: [
        { role: 'user', text: `The conversation so far, compacted:\n\n${outcome.text}`, toolUses: [] },
        { role: 'assistant', text: 'Özeti aldım; kaldığımız yerden devam ediyorum.', toolUses: [] },
      ],
      usage: {
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })

  on('command.run', { command: 'commandcode' }, async ($, e) => {
    const args = String((e as unknown as { args?: string }).args ?? '').trim()
    const [verb, ...rest] = args.split(/\s+/).filter(Boolean)
    const note = rest.join(' ')

    const setConfig = async (patch: Partial<Config>) => setConfigOf($, patch)

    if (verb === 'continue') {
      await setSessionRoute($, await $.session.id(), true)
      let message =
        'Command Code yönlendirmesi bu sohbet için açık: sonraki turlar aynı sohbette Command Code ile yanıtlanır, Claude kotası harcanmaz. Kapatmak için: /commandcode route off'
      if (note) {
        try {
          await $.prompt.submit({ text: note })
          message += `\nGönderildi: ${note}`
        } catch (err) {
          message += `\nNot gönderilemedi (${err instanceof Error ? err.message : String(err)}); kendin yazabilirsin.`
        }
      }
      return { text: message }
    }
    if (verb === 'route') {
      const cfg = await config($)
      const sub = rest[0]
      if (!sub) {
        return {
          text: [
            `Yönlendirme: ${await routeState($, cfg)}`,
            `model ${cfg.routeModel || cfg.model || 'CLI varsayılanı'} · mod ${cfg.routeMode}`,
            '/commandcode route on | off · route model <numara|id> · route mode read|edit|full',
          ].join('\n'),
        }
      }
      if (sub === 'on' || sub === 'off') {
        await setConfig({ route: sub === 'on' })
        await setSessionRoute($, await $.session.id(), sub === 'on')
        if (sub === 'off') await saveRoute($, await $.session.id(), null)
        return {
          text:
            sub === 'on'
              ? 'Yönlendirme açık (tüm oturumlar): turları Command Code yanıtlar. Yalnız bu sohbet için: /commandcode continue'
              : 'Yönlendirme kapalı (tüm oturumlar ve bu sohbet): turları Claude yanıtlar.',
        }
      }
      if (sub === 'model') {
        const query = rest.slice(1).join(' ')
        if (!query) return { text: modelsText(cfg) }
        const found = resolveModel(query)
        if ('error' in found) return { text: found.error }
        await setConfig({ routeModel: found.id })
        return { text: `Yönlendirme modeli: ${found.id}` }
      }
      if (sub === 'mode') {
        const mode = rest[1]
        if (mode !== 'read' && mode !== 'edit' && mode !== 'full') return { text: 'Mod read, edit ya da full olmalı.' }
        await setConfig({ routeMode: mode })
        return { text: `routeMode = ${mode}` }
      }
      return { text: 'Bilinmeyen alt komut. route [on|off|model <id>|mode read|edit|full]' }
    }
    if (verb === 'models') return { text: modelsText(await config($)) }
    if (verb === 'model') {
      const cfg = await config($)
      if (!note) return { text: modelsText(cfg) }
      const found = resolveModel(note)
      if ('error' in found) return { text: found.error }
      await setConfig({ model: found.id })
      return { text: `run aracının modeli: ${found.id}${cfg.routeModel ? '' : ' (yönlendirme de bunu kullanır)'}` }
    }
    if (verb === 'handoff') {
      const cfg = await config($)
      const handoff = await buildHandoff($, cfg, note)
      let message = [
        `Command Code oturumu hazır · ${handoff.messages} mesaj · ${handoff.sessionId}`,
        `Dosya: ${handoff.path}`,
        `Komut: ${handoff.command}`,
      ].join('\n')
      if (note) message += `\nNot: ${note}`
      return { text: message }
    }
    if (verb === 'revoke' && (rest[0] === 'edit' || rest[0] === 'full')) {
      await setGrant($, rest[0], false)
      return { text: `Geri alındı: bu projede "${rest[0]}" yeniden sorulacak.` }
    }
    if (verb === 'doctor') return { text: await doctor($) }
    if (verb === 'usage') return { text: await usageText($) }
    if (verb === 'clear-cache') {
      await $.store.delete('cache')
      return { text: 'Cache temizlendi.' }
    }
    if (verb === 'set' && rest.length >= 1) {
      const key = rest[0] as keyof Config
      if (!(key in DEFAULTS)) return { text: `Bilinmeyen ayar. Ayarlar: ${Object.keys(DEFAULTS).join(', ')}` }
      const raw = rest.slice(1).join(' ')
      const fallback = DEFAULTS[key]
      let value: string | number | boolean
      if (typeof fallback === 'number') {
        value = Number(raw)
        if (!Number.isFinite(value)) return { text: `${key} bir sayı bekliyor.` }
      } else if (typeof fallback === 'boolean') {
        value = /^(1|true|yes|on|evet|açık)$/i.test(raw)
      } else if ((key === 'model' || key === 'routeModel') && raw) {
        const found = resolveModel(raw)
        if ('error' in found) return { text: found.error }
        value = found.id
      } else {
        value = raw
      }
      const stored = ((await $.store.get('config')) ?? {}) as Partial<Config>
      await $.store.set('config', { ...stored, [key]: value })
      return { text: `${key} = ${JSON.stringify(value)}` }
    }
    if (verb) return { text: `Bilinmeyen alt komut: ${verb}\n${HELP}` }
    return { text: await overview($) }
  })

  // Warn before the quota runs out: /commandcode continue is answered by this
  // mod alone, so it still works once Claude refuses to run a turn.
  const warned = new Set<string>()
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    try {
      const usage = await $.session.usage()
      const percent = Math.max(
        0,
        ...(usage.rateLimits ?? []).map((limit) => limit.percentUsed ?? 0),
        usage.context?.percent ?? 0,
      )
      const cfg = await config($)
      if (percent >= cfg.warnAtPercent) {
        const id = await $.session.id()
        if (!warned.has(id)) {
          warned.add(id)
          $.ui.toast(`Claude kullanımı %${Math.round(percent)} · sohbeti Command Code'da sürdürmek için /commandcode continue`, {
            timeoutMs: 12000,
          })
        }
      }
    } catch {
      // A reading failure must not break the turn.
    }
    return measured
  })
}

const ROUTE_KEYS = ['route', 'routeModel', 'routeMode', 'model']

/** One wording for routing everywhere: what answers this conversation, and why. */
async function routeState($: $, cfg: Config): Promise<string> {
  if (cfg.route) return 'açık (tüm oturumlar, route on)'
  if (await sessionRouteOn($, await $.session.id())) return 'açık (yalnız bu sohbet, /commandcode continue)'
  return 'kapalı (turları Claude yanıtlar) · aç: /commandcode continue (bu sohbet) ya da route on (tümü)'
}

const HELP =
  'Komutlar: /commandcode continue [not] | route on|off|model <n>|mode read|edit|full | models | model <n> | usage | doctor | handoff [not] | agents | revoke edit|full | clear-cache | set <key> <value>'

// --- usage: the subscription's credits and window limits --------------------

type Window = { used: number; cap: number; exceeded: boolean; resetAt: number }
type Usage = {
  plan: string
  monthly: number
  purchased: number
  fiveHour: Window | null
  weekly: Window | null
  periodEnd: string
  requests: number
  tokensIn: number
  tokensOut: number
}

const USAGE_API = 'https://api.commandcode.ai'
let usageMemo: { at: number; value: Usage } | null = null

/** What /usage in Command Code shows, read from the same endpoints with the CLI's own key. */
async function fetchUsage($: $, maxAgeMs = 60000): Promise<Usage | { error: string }> {
  const now = await $.clock.now()
  if (usageMemo && now - usageMemo.at < maxAgeMs) return usageMemo.value
  let key = ''
  try {
    key = String((JSON.parse(String(await $.fs.read(join(await ccHome($), 'auth.json')))) as { apiKey?: string }).apiKey ?? '')
  } catch {
    // Handled below.
  }
  if (!key) return { error: 'Command Code girişi yok: terminalde `commandcode login`' }
  const get = async (path: string): Promise<any> => {
    const res = await $.http.fetch(`${USAGE_API}${path}`, { headers: { Authorization: `Bearer ${key}` } })
    if (res.status === 401 || res.status === 403) throw new Error('auth')
    if (!res.ok) throw new Error(`${path} ${res.status}`)
    return JSON.parse(res.text)
  }
  try {
    const [credits, subscription, summary] = await Promise.all([
      get('/alpha/billing/credits'),
      get('/alpha/billing/subscriptions').catch(() => null),
      get('/alpha/usage/summary').catch(() => null),
    ])
    const windowOf = (raw: any): Window | null =>
      raw && typeof raw.cap === 'number'
        ? { used: Number(raw.used) || 0, cap: raw.cap, exceeded: raw.exceeded === true, resetAt: Number(raw.resetAt) || 0 }
        : null
    const value: Usage = {
      plan: String(subscription?.data?.planId ?? '?'),
      monthly: Number(credits?.credits?.monthlyCredits) || 0,
      purchased: Number(credits?.credits?.purchasedCredits) || 0,
      fiveHour: windowOf(credits?.windowLimits?.fiveHour),
      weekly: windowOf(credits?.windowLimits?.weekly),
      periodEnd: String(subscription?.data?.currentPeriodEnd ?? ''),
      requests: Number(summary?.totalCount) || 0,
      tokensIn: Number(summary?.totalTokensIn) || 0,
      tokensOut: Number(summary?.totalTokensOut) || 0,
    }
    usageMemo = { at: now, value }
    return value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'auth') return { error: explainError('401 API key expired') }
    return { error: `Kullanım okunamadı: ${message}` }
  }
}

function percentOf(w: Window | null): number {
  return w && w.cap > 0 ? Math.round((w.used / w.cap) * 100) : 0
}

function resetIn(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  if (minutes < 60) return `${minutes} dk`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} sa` : `${Math.round(hours / 24)} gün`
}

function bar(w: Window | null): string {
  const filled = Math.min(10, Math.round(percentOf(w) / 10))
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`
}

function windowLine(label: string, w: Window | null, now: number): string {
  if (!w) return `${label}: limit yok`
  const left = Math.max(0, w.cap - w.used)
  return `${label} ${bar(w)} %${percentOf(w)} · kalan ${left.toFixed(2)}/${w.cap} kredi · sıfırlanma ${resetIn(w.resetAt, now)}${
    w.exceeded ? ' · DOLDU' : ''
  }`
}

/** One line for a run's footer. */
function usageShort(u: Usage): string {
  const left = (w: Window | null) => (w ? `${Math.max(0, w.cap - w.used).toFixed(2)}/${w.cap}` : '-')
  return `CC kalan: 5 saat ${left(u.fiveHour)} · hafta ${left(u.weekly)} · ay ${u.monthly.toFixed(2)} kredi`
}

/** The run footer's usage line, fresh after the run; a warning toast past 85%. */
async function usageFooter($: $): Promise<string> {
  const u = await fetchUsage($, 0)
  if ('error' in u) return ''
  warnUsage($, u)
  return usageShort(u)
}

async function usageOverview($: $): Promise<string> {
  const u = await fetchUsage($)
  return 'error' in u ? `Kullanım: ${u.error}` : `Kullanım: ${usageShort(u)} · ayrıntı /commandcode usage`
}

async function usageText($: $): Promise<string> {
  const u = await fetchUsage($, 0)
  if ('error' in u) return `Command Code kullanım\n${u.error}`
  const now = await $.clock.now()
  return [
    `Command Code kullanım · plan ${u.plan}${u.periodEnd ? ` · dönem sonu ${new Date(u.periodEnd).toLocaleDateString('tr-TR')}` : ''}`,
    windowLine('5 saat', u.fiveHour, now),
    windowLine('Hafta ', u.weekly, now),
    `Aylık kalan ${u.monthly.toFixed(2)} kredi${u.purchased ? ` · satın alınan ${u.purchased.toFixed(2)}` : ''}`,
    `Bu dönem: ${u.requests} istek · ${(u.tokensIn / 1e6).toFixed(1)}M in / ${(u.tokensOut / 1e3).toFixed(0)}K out token`,
  ].join('\n')
}

/** Warns once per window when it passes 85%, so a delegation does not hit the wall unseen. */
const usageWarned = new Set<string>()
function warnUsage($: $, u: Usage): void {
  for (const [label, w] of [['5 saatlik', u.fiveHour], ['haftalık', u.weekly]] as const) {
    if (!w) continue
    const key = `${label}:${w.resetAt}`
    if ((w.exceeded || percentOf(w) >= 85) && !usageWarned.has(key)) {
      usageWarned.add(key)
      $.ui.toast(`Command Code ${label} limit %${percentOf(w)} dolu · kalan ${Math.max(0, w.cap - w.used).toFixed(2)} kredi`, {
        timeoutMs: 8000,
      })
    }
  }
}

/** Checks the CLI, the login and one real round trip on the configured model. */
async function doctor($: $): Promise<string> {
  const cfg = await config($)
  const lines = ['Command Code doctor']
  const argv = await cliArgv($, cfg)
  lines.push(`CLI: ${argv.join(' ')}`)
  try {
    const auth = JSON.parse(String(await $.fs.read(join(await ccHome($), 'auth.json')))) as {
      userName?: string
      authenticatedAt?: string
    }
    lines.push(`Giriş: ${auth.userName ?? '?'} · ${auth.authenticatedAt ? new Date(auth.authenticatedAt).toLocaleString('tr-TR') : 'tarih yok'}`)
  } catch {
    lines.push('Giriş: ~/.commandcode/auth.json yok; terminalde `commandcode login`')
  }
  const started = await $.clock.now()
  const probe = await runCommandCode(
    $,
    { prompt: 'Reply with exactly: PONG', model: cfg.model, mode: 'read', resume: '', maxTurns: 1, label: 'doctor' },
    undefined,
  )
  const secs = Math.round(((await $.clock.now()) - started) / 1000)
  if (probe.error) lines.push(`Deneme: HATA · ${explainError(probe.error)}`)
  else if (!probe.text.trim()) lines.push(`Deneme: boş yanıt · ${probe.model || cfg.model} · ${secs} sn`)
  else lines.push(`Deneme: OK · ${probe.model || cfg.model} · ${secs} sn · "${oneLine(probe.text, 40)}"`)
  const u = await fetchUsage($, 0)
  lines.push('error' in u ? `Kullanım: ${u.error}` : usageShort(u))
  return lines.join('\n')
}

async function overview($: $): Promise<string> {
  const cfg = await config($)
  const g = await grants($)
  const agents = await agentsOf($)
  const runs = ((await $.store.get('runs')) ?? []) as RunRecord[]
  const cache = ((await $.store.get('cache')) ?? {}) as Record<string, CacheEntry>
  const handoffs = await lastHandoffs($)
  const profiles = await ccAgents($)
  const last = handoffs[handoffs.length - 1]

  const agentLines = Object.entries(agents).map(
    ([name, rec]) => `- ${name}: ${rec.model || 'varsayılan model'}, ${rec.runs} çalışma, session ${rec.sessionId}`,
  )
  const profileLines = profiles.map((agent) =>
    [
      `- ${agent.name} (${agent.source})`,
      agent.model ? agent.model : '',
      agent.description ? oneLine(agent.description, 80) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  )
  const runLines = runs
    .slice(-10)
    .reverse()
    .map(
      (run) =>
        `- ${run.status} · ${run.subagent ? `${run.subagent}/` : ''}${run.agent || 'one-off'} · ${
          run.model || 'varsayılan'
        } · ${run.mode} · ${Math.round(run.durationMs / 1000)} sn · ${run.inputTokens}/${run.outputTokens} tok · ${oneLine(
          run.preview,
          80,
        )}`,
    )

  return [
    'Command Code bridge',
    `İzinler bu projede: read her zaman · edit ${g.edit ? 'her zaman' : 'sorulur'} (kabuk kapalı) · full ${
      g.full ? 'her zaman' : 'sorulur'
    }`,
    `Yönlendirme: ${await routeState($, cfg)} · ${cfg.routeMode} · ${cfg.routeModel || cfg.model || 'CLI varsayılanı'}`,
    `run aracı modeli: ${cfg.model || 'CLI varsayılanı'} · değiştir: /commandcode model <numara>`,
    `Modeller: ${modelCount()} Command Code modeli · liste için /commandcode models`,
    await usageOverview($),
    `Ayarlar: ${Object.keys(DEFAULTS)
      .filter((key) => !ROUTE_KEYS.includes(key))
      .map((key) => `${key}=${JSON.stringify((cfg as unknown as Record<string, unknown>)[key])}`)
      .join(' · ')}`,
    `Cache: ${Object.keys(cache).length} yanıt, ${cfg.cacheTtlMin} dk · uyarı eşiği %${cfg.warnAtPercent}`,
    '',
    'Devretme:',
    ...(last
      ? [`- son: ${new Date(last.at).toLocaleString('tr-TR')} · ${last.messages} mesaj · ${last.sessionId}`, `- ${last.command}`]
      : ['- henüz yok; /commandcode handoff sohbeti kalıcı bir Command Code oturumuna yazar']),
    '',
    'Bu projedeki köprü ajanları:',
    ...(agentLines.length ? agentLines : ['- yok']),
    '',
    'Command Code ajan profilleri (.commandcode/agents):',
    ...(profileLines.length ? profileLines : ['- yok']),
    '',
    'Son çalışmalar:',
    ...(runLines.length ? runLines : ['- yok']),
    '',
    '',
    HELP,
  ].join('\n')
}
