// Exercise the installed, patched TUI handlers without starting an agent or deleting files.
// node tests/tui-session-delete-runtime.mjs /path/to/@deepseek-harness-tui/dsh-tui
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'

const root = process.argv[2]
assert.ok(root, 'Pass the patched TUI package directory')
const read = relative => readFileSync(join(root, 'lib/types', relative), 'utf8')
const screen = read('screens/SessionSupervisor.js')
const hook = read('screens/sessionSupervisor/useSessionSupervisor.js')
const action = hook.match(/const deleteSession = useCallback\(\(session\) => \{[\s\S]*?\n    \}, \[[^\]]+\]\);/)?.[0]
assert.ok(action, 'Find the actual deletion handler')

for (const scenario of [
  { name: 'stored DSH session', dsh: true, live: undefined, deletes: 1, reloads: 1 },
  { name: 'current DSH session', dsh: true, live: { live: true, current: true }, deletes: 0, reloads: 0 },
  { name: 'parked DSH session', dsh: true, live: { live: true, current: false }, deletes: 0, reloads: 0 },
  { name: 'another TUI owns the session', dsh: true, holder: 123, deletes: 0, reloads: 0 },
  { name: 'backend refuses deletion', dsh: true, result: false, deletes: 1, reloads: 0 },
  { name: 'backend throws', dsh: true, throws: true, deletes: 1, reloads: 0 },
  { name: 'other backend remains usable', dsh: false, deletes: 1, reloads: 1 },
  { name: 'current other backend', dsh: false, live: { current: true }, deletes: 0, reloads: 0 },
]) {
  let deletes = 0, reloads = 0
  const notices = []
  const context = {
    dshBackend: scenario.dsh, archiveSessions: false,
    liveStateOf: () => scenario.live, holderOf: () => scenario.holder,
    useCallback: callback => callback,
    t: key => key, report: (...args) => notices.push(args), message: error => error.message,
    reload: () => { reloads++ },
    channel: { deleteSession: async id => {
      assert.equal(id, 'target')
      deletes++
      if (scenario.throws) throw new Error('storage failure')
      return scenario.result ?? true
    } },
  }
  const remove = runInNewContext(`${action}\ndeleteSession`, context)
  remove({ id: 'target', title: { text: 'Test session' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deletes, scenario.deletes, scenario.name)
  assert.equal(reloads, scenario.reloads, scenario.name)
  assert.equal(notices.length, 1, scenario.name)
}

const binding = screen.match(/if \(isMod\(key\) && input === 'd'\) \{[\s\S]*?\n        \}/)?.[0]
assert.ok(binding, 'Ctrl+D must be available for DSH')
for (const pane of ['rail', 'list']) {
  let target
  runInNewContext(`(() => { ${binding} })()`, {
    isMod: key => key.ctrl, key: { ctrl: true }, input: 'd', activePane: pane,
    focusedSession: { id: 'target' }, setConfirmDelete: id => { target = id },
  })
  assert.equal(target, pane === 'list' ? 'target' : undefined)
}

const confirm = screen.slice(screen.indexOf('if (confirmDelete !== undefined) {'), screen.indexOf('if (rename !== undefined) {'))
assert.ok(confirm.includes('deleteSession(target)'), 'Find confirmation handler')
for (const enter of [true, false]) {
  let deletes = 0, cleared = false
  runInNewContext(`(() => { ${confirm} })()`, {
    confirmDelete: 'target', isPlainReturn: () => enter, key: { escape: !enter },
    listedSessions: [{ id: 'target' }], setConfirmDelete: () => { cleared = true },
    deleteSession: () => { deletes++ },
  })
  assert.equal(deletes, enter ? 1 : 0)
  assert.equal(cleared, true)
}
// Execute the actual storage helper against temporary data, not mocks of
// channel.deleteSession. An empty session never had a persisted log.
const storage = read('dsh-adapter/compat/sessionLog.js')
const helper = storage.slice(storage.indexOf('export function deleteSessionLog(sessionId) {'))
assert.ok(helper.startsWith('export function deleteSessionLog'))
const temporary = mkdtempSync(join(tmpdir(), 'dsh-delete-regression-'))
try {
  const sessionRoot = join(temporary, 'sessions')
  mkdirSync(join(sessionRoot, 'workspace'), { recursive: true })
  const context = {
    readdirSync, realpathSync, rmSync, dirname, join, sep,
    isSafeSessionId: id => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id),
    sessionsRoots: () => [sessionRoot, join(temporary, 'absent-root')],
  }
  const remove = runInNewContext(`${helper.replace('export function', 'function')}\ndeleteSessionLog`, context)
  for (const [id, filename] of [['compressed', 'session.v4.jsonl.zstd'], ['plain', 'session.v4.jsonl'], ['empty', undefined]]) {
    const directory = join(sessionRoot, 'workspace', id)
    mkdirSync(directory)
    if (filename) writeFileSync(join(directory, filename), 'disposable test log')
    assert.equal(remove(id), 'deleted', id)
    assert.equal(existsSync(directory), false, id)
  }
  assert.equal(remove('never-persisted'), 'deleted')
  assert.equal(remove('../workspace'), 'unavailable')
  const outside = join(temporary, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(sessionRoot, 'workspace', 'outside-link'))
  assert.equal(remove('outside-link'), 'unavailable')
  assert.equal(existsSync(outside), true)
  const fail = runInNewContext(`${helper.replace('export function', 'function')}\ndeleteSessionLog`, {
    ...context, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  })
  assert.equal(fail('unreadable'), 'unavailable')

  // Verify that the real channel action forgets an unstored session's row,
  // recent-session note and resume marker, while preserving the current one.
  const metadata = read('dsh-adapter/channel/session-metadata.js')
  const start = metadata.indexOf('const deleteSession = async (sessionId) => {')
  const end = metadata.indexOf('const renameSessionTo', start)
  const method = metadata.slice(start, end)
  let rows = [{ id: 'never-persisted' }, { id: 'current' }]
  const forgotten = [], agentViews = []
  let resumeCleared = false
  const channelDelete = runInNewContext(`${method}\ndeleteSession`, {
    deps: { binding: { capture: () => ({ agent: { session: { id: 'current' } } }) },
      forgetAgentView: id => agentViews.push(id) },
    current: () => true, deleteSessionLog: remove,
    cachedSessions: () => rows, saveMutation: next => { rows = next },
    forgetSession: id => forgotten.push(id), readResumeTarget: () => 'never-persisted',
    clearResumeTarget: () => { resumeCleared = true },
  })
  assert.equal(await channelDelete('never-persisted'), true)
  assert.deepEqual(rows.map(row => row.id), ['current'])
  assert.deepEqual(forgotten, ['never-persisted'])
  assert.deepEqual(agentViews, ['never-persisted'])
  assert.equal(resumeCleared, true)
  assert.equal(await channelDelete('current'), false)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
console.log('Passed: keyboard, confirmation, live guards, stored and unstored deletion, metadata cleanup and filesystem refusal cases')
