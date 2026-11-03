import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverModels, sdkOptions, streamStep, transcript, toolServer } from './bridge.js'

const request = { model: 'haiku', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values }
function fakeQuery(messages, observe = () => {}) {
  let closed = false
  const run = options => {
    observe(options)
    return { close: () => { closed = true }, async *[Symbol.asyncIterator]() { yield* messages } }
  }
  return { run, closed: () => closed }
}

test('only the official CLI handles subscription authentication', async () => {
  const options = sdkOptions(new AbortController(), {
    HOME: '/test', ANTHROPIC_API_KEY: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: 'token',
    ANTHROPIC_BASE_URL: 'proxy', ANTHROPIC_AUTH_TOKEN: 'secret',
  })
  assert.equal(options.env.HOME, '/test')
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(options.env.ANTHROPIC_BASE_URL, undefined)
  assert.deepEqual(options.tools, [])
  assert.equal(options.strictMcpConfig, true)
  assert.equal((await options.canUseTool('Bash', {})).behavior, 'deny')
})

test('history preserves tool calls, results and system instructions', () => {
  const rendered = transcript({ messages: [
    { role: 'system', content: [{ type: 'text', text: 'Follow DSH permissions.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call1', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 'call1', isError: true, content: [{ type: 'text', text: 'not found' }] },
  ] })
  assert.match(rendered.system, /Follow DSH permissions/)
  const history = JSON.parse(rendered.prompt)
  assert.equal(history[0].content[0].name, 'read')
  assert.equal(history[1].toolCallId, 'call1')
  assert.equal(history[1].isError, true)
})

test('tool schemas produce distinct MCP aliases with original DSH names', () => {
  const { names } = toolServer([{ name: 'bash', description: 'shell', parameters: {
    type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
  } }])
  assert.equal(names.get('mcp__dsh__tool_0'), 'bash')
})

test('tool request ends the SDK turn and returns execution to DSH', async () => {
  const fake = fakeQuery([{ type: 'assistant', message: { usage: { input_tokens: 3, output_tokens: 5 }, content: [
    { type: 'tool_use', id: 'call1', name: 'mcp__dsh__tool_0', input: { command: 'pwd' } },
  ] } }, { type: 'result', is_error: true, errors: ['must not reach this'] }])
  const chunks = await collect(streamStep({ ...request, tools: [{ name: 'bash', description: 'shell',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] }, fake.run))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block,
    { type: 'tool-call', id: 'call1', name: 'bash', arguments: '{"command":"pwd"}' })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(fake.closed(), true)
})

test('plain replies finish once and preserve disjoint cache usage', async () => {
  const fake = fakeQuery([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'result', usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10 } },
  ])
  const chunks = await collect(streamStep(request, fake.run))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello')
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.cacheReadTokens, 10)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(fake.closed(), true)
})

test('SDK failures and unavailable tools surface as errors', async () => {
  const failure = fakeQuery([{ type: 'result', is_error: true, errors: ['rate limited'] }])
  await assert.rejects(collect(streamStep(request, failure.run)), /rate limited/)
  assert.equal(failure.closed(), true)
  const unavailable = fakeQuery([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }])
  await assert.rejects(collect(streamStep(request, unavailable.run)), /unavailable tool: Bash/)
})

test('cancellation aborts and closes the SDK child', async () => {
  const controller = new AbortController()
  const fake = fakeQuery([], ({ options }) => {
    controller.abort()
    assert.equal(options.abortController.signal.aborted, true)
  })
  await assert.rejects(collect(streamStep({ ...request, signal: controller.signal }, fake.run)))
  assert.equal(fake.closed(), true)
  await assert.rejects(collect(streamStep({ ...request, signal: controller.signal }, () => assert.fail('must not start'))))
})

test('catalog discovery makes no user request and closes the process', async () => {
  let closed = false
  const models = await discoverModels(({ prompt }) => {
    assert.equal(typeof prompt[Symbol.asyncIterator], 'function')
    return { supportedModels: async () => [{ value: 'sonnet' }], close: () => { closed = true } }
  })
  assert.deepEqual(models, [{ value: 'sonnet' }])
  assert.equal(closed, true)
})

test('unsupported image input fails explicitly before starting Claude', async () => {
  await assert.rejects(collect(streamStep({ ...request, messages: [{ role: 'user', content: [{ type: 'image' }] }] },
    () => assert.fail('must not start'))), /image input/)
})
