import { expect, test } from 'claude-code/testing'

// Command Code's NDJSON, in the shapes v1.88 writes (recorded 2026-11-09):
// a call on a path outside the workspace is denied and the run ends at once.
const ev = (event: object) => JSON.stringify({ type: 'event', event }) + '\n'
// A folder on another drive, with a space and non-ASCII letters, like real notes folders.
const NOTES = 'D:\\Notes\\Tasarım Notları'
const PLAN = `${NOTES}\\Plan`
const HOME = 'C:\\Users\\dev\\project'
const SID = '00000000-1111-4222-8333-444444444444'

const denied = (opening: string) =>
  ev({ type: 'run_start', sessionId: SID }) +
  ev({ type: 'turn_start', turnNumber: 1 }) +
  ev({ type: 'model_request_start', model: 'deepseek/deepseek-v4.1-flash-fast' }) +
  ev({ type: 'tool_queued', toolCallId: 'c1', toolName: 'glob', input: { pattern: '*.md', path: PLAN } }) +
  ev({ type: 'tool_denied', toolCallId: 'c1', toolName: 'glob' }) +
  ev({ type: 'run_end', result: { finalText: opening, stopReason: 'permission_denied', sessionId: SID, usage: { inputTokens: 100, outputTokens: 5 } } })

const answered = (text: string) =>
  ev({ type: 'run_start', sessionId: SID }) +
  ev({ type: 'turn_start', turnNumber: 1 }) +
  ev({ type: 'run_end', result: { finalText: text, stopReason: 'end_turn', sessionId: SID, usage: { inputTokens: 200, outputTokens: 20 } } })

type Spawn = { argv: string[]; input: string; cwd?: string }

/** The engine beneath the bridge: a small file system, a store, and Command Code replies in order. */
function engine(on: any, replies: string[], spawns: Spawn[]) {
  const dirs = new Set([HOME, 'D:\\Notes', NOTES, PLAN])
  const files = new Set([`${PLAN}\\GDD.md`])
  const store = new Map<string, unknown>()
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '')
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: HOME }))
  on('session.root', () => ({ value: HOME }))
  on('session.id', () => ({ value: 'claude-session' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('env.get', (_: any, e: any) => ({
    value: e.name === 'APPDATA' ? 'C:\\Users\\dev\\AppData\\Roaming' : e.name === 'USERPROFILE' ? 'C:\\Users\\dev' : undefined,
  }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('fs.exists', (_: any, e: any) => ({ value: /command-code[\\/]dist[\\/]index\.mjs$/.test(e.path) || dirs.has(norm(e.path)) || files.has(norm(e.path)) }))
  on('fs.stat', (_: any, e: any) => {
    const p = norm(e.path)
    if (dirs.has(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    if (files.has(p)) return { value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }
    throw Object.assign(new Error(`ENOENT: ${e.path}`), { code: 'ENOENT' })
  })
  on('fs.list', (_: any, e: any) => ({ value: norm(e.path) === PLAN ? [{ name: 'GDD.md', kind: 'file', size: 4096 }] : [] }))
  on('fs.read', () => ({ value: '' }))
  on('http.fetch', () => {
    throw new Error('offline')
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.register', (_: any, e: any) => ({ value: { name: e.name } }))
  on('command.register', () => ({ value: { command: 'commandcode' } }))
  on('tool.call', () => ({ result: {} }))
  on('process.spawn', async function* (_: any, e: any) {
    spawns.push({ argv: [...e.argv], input: String(e.input ?? ''), cwd: e.cwd })
    const text = replies.shift() ?? ''
    if (text) yield { stream: 'stdout', text }
    return { value: { code: 0, signal: null } }
  })
}

const RUN = 'mcp__commandcode-bridge__run'
const resultText = (r: any) => String(r?.result ?? r?.text ?? '')
const addDirsOf = (s: Spawn) => s.argv.flatMap((a, i) => (a === '--add-dir' ? [s.argv[i + 1]] : []))

test('a task about a folder outside the project runs in that folder', async ($: any, on: any) => {
  const spawns: Spawn[] = []
  engine(on, [answered('GDD.md\nheader at line 127')], spawns)
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: RUN, prompt: `Read-only. In the folder ${PLAN} (only the .md files) list them.`, useCache: false })
  expect(spawns.length).toBe(1)
  // --add-dir does not open Command Code's file tools; starting there does.
  expect(spawns[0]!.cwd).toBe(PLAN)
  expect(addDirsOf(spawns[0]!)).toEqual([])
  expect(spawns[0]!.input).toContain(`Working folder: ${PLAN}`)
  expect(spawns[0]!.input).toContain('Do not modify any file')
  expect(spawns[0]!.input).toContain('GDD.md 4k') // the map of the folder the task is about
  expect(resultText(r)).toContain('header at line 127')
})

test('a run stopped by a denied path continues its session inside that folder', async ($: any, on: any) => {
  const spawns: Spawn[] = []
  engine(on, [denied("I'll start by locating the folder."), answered('Pazar notları.md\nGDD.md')], spawns)
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: RUN, prompt: 'List the plan notes of the farm game.', useCache: false })
  expect(spawns.length).toBe(2)
  expect(spawns[0]!.cwd).toBeUndefined() // the session's own folder
  expect(spawns[1]!.cwd).toBe(PLAN)
  expect(addDirsOf(spawns[1]!)).toEqual([HOME]) // the old folder kept as an extra
  expect(spawns[1]!.argv).toContain('--session')
  expect(spawns[1]!.argv).toContain(SID)
  expect(resultText(r)).toContain('Pazar notları.md')
  expect(resultText(r)).not.toContain("I'll start")
})

test('a denial it cannot fix is an error, never the opening line as an answer', async ($: any, on: any) => {
  const spawns: Spawn[] = []
  engine(on, [denied("I'll start by locating the folder."), denied('Still looking.')], spawns)
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: RUN, prompt: 'List the plan notes of the farm game.', useCache: false })
  expect(spawns.length).toBe(2) // no blind retry after the resume
  expect(r?.isError).toBe(true)
  expect(resultText(r)).toContain('was denied glob')
  expect(resultText(r)).toContain(PLAN)
})

test('a long conversation never pushes the rules out of the prompt', async ($: any, on: any) => {
  const spawns: Spawn[] = []
  engine(on, [answered('ok')], spawns)
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: RUN, prompt: `Summarise this.\n${'x'.repeat(90000)}\nEnd of task.`, useCache: false })
  const input = spawns[0]!.input
  expect(input.length).toBeLessThanOrEqual(40000)
  expect(input).toContain('Do not modify any file')
  expect(input).toContain('End of task.')
})
