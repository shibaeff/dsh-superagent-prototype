// Exercise the installed, patched TUI handlers without starting an agent or deleting files.
// node tests/tui-session-delete-runtime.mjs /path/to/@deepseek-harness-tui/dsh-tui
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
console.log('Passed: deletion guards, backend failures, Ctrl+D focus, Enter confirmation and Esc cancellation')
