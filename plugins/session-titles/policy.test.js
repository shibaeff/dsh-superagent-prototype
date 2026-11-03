import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProvider, meaningful, parseTitle, titleInput, TITLE_SYSTEM } from './policy.js'

const current = (title, kind = 'provider') => ({ title, source: { kind } })
const response = title => ({ blocks: [{ type: 'text', text: title }], finish: { kind: 'stop' }, model: { provider: 'test', model: 'test' } })

test('acknowledgements and build/push followups do not rename a task', async () => {
  const provider = createProvider(() => assert.fail('must not call a model'))
  for (const text of ['continue', 'xcontinue', 'thanks', 'pls continue', 'push build reinstall fixed version']) {
    assert.equal(meaningful(text), false, text)
    const result = await provider.generate({ currentTitle: current('Claude subscription provider'),
      messages: [{ seq: 1, text: 'Enable Claude subscription models' }, { seq: 2, text }] })
    assert.equal(result.title, 'Claude subscription provider')
  }
  assert.equal(meaningful('Build a validator dashboard'), true)
})

test('a vague opening is excluded when the actual task arrives', () => {
  const prepared = titleInput({ currentTitle: current('Hello'), messages: [
    { seq: 1, text: 'hello' }, { seq: 2, text: 'Fix Canton validator metrics' },
  ] })
  assert.equal(prepared.anchor, undefined)
  assert.deepEqual(prepared.messageSeqs, [2])
})

test('titles can follow a changed topic, preserving the current wording as an anchor', async () => {
  const provider = createProvider(async (_request, prepared) => {
    const input = JSON.parse(prepared.input)
    assert.equal(input.currentTitle, 'Canton validator metrics')
    assert.equal(input.messages.at(-1).text, 'Now add Claude subscription support to DSH')
    return response('DSH Claude subscription provider')
  })
  const result = await provider.generate({ currentTitle: current('Canton validator metrics'), messages: [
    { seq: 1, text: 'Fix Canton validator metrics' }, { seq: 2, text: 'Now add Claude subscription support to DSH' },
  ] })
  assert.equal(result.title, 'DSH Claude subscription provider')
  assert.deepEqual(result.messageSeqs, [1, 2])
})

test('a followup can recover a failed or cancelled initial generation', async () => {
  let calls = 0
  const provider = createProvider(async () => { calls++; return response('Canton validator metrics') })
  const result = await provider.generate({ currentTitle: current('pls fix the', 'fallback'), messages: [
    { seq: 1, text: 'pls fix the Canton validator metrics' }, { seq: 2, text: 'continue' },
  ] })
  assert.equal(calls, 1)
  assert.equal(result.title, 'Canton validator metrics')
})

test('large conversations stay bounded and retain first and latest meaningful requests', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, text: `Task ${i}: ` + '\u0000🙂"'.repeat(2000) }))
  const prepared = titleInput({ messages })
  assert.ok(Buffer.byteLength(prepared.input) <= 8192)
  assert.equal(prepared.messageSeqs[0], 1)
  assert.equal(prepared.messageSeqs.at(-1), 100)
  assert.ok(!prepared.input.includes('�'))
})

test('output parser rejects errors and tools, and removes presentation wrappers', () => {
  assert.equal(parseTitle(response('**Canton validator metrics**\nSome explanation')), 'Canton validator metrics')
  assert.equal(parseTitle(response('Title: "DSH Claude provider"')), 'DSH Claude provider')
  assert.throws(() => parseTitle(response('Hello')), /generic/)
  assert.throws(() => parseTitle({ blocks: [], finish: { kind: 'max-tokens' } }), /did not finish/)
  assert.throws(() => parseTitle({ blocks: [{ type: 'tool-call' }], finish: { kind: 'stop' } }), /did not finish/)
  assert.match(TITLE_SYSTEM, /return it EXACTLY unchanged/)
})
