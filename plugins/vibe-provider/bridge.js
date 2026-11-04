import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PROVIDER = 'vibe-cli'
const HANDOFF = 'DSH_TOOL_HANDOFF'
const MAX_BYTES = 16 * 1024 * 1024

export function models(env = process.env) {
  return [{ id: 'default', name: 'Vibe configured model' },
    ...[...new Set((env.DSH_VIBE_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean))]
      .filter(id => id !== 'default').map(id => ({ id, name: `Vibe / ${id}` }))]
}

export function requestInput(options) {
  const messages = options.messages ?? []
  if (messages.some(message => message.content.some(block => block.type === 'image' || block.type === 'file')))
    throw new Error('The Vibe CLI bridge currently supports text and DSH tools, not image/file attachments')
  if (options.temperature !== undefined || options.stop?.length || options.reasoningEffort !== undefined)
    throw new Error('Use Vibe configuration for thinking/temperature; this bridge does not expose those or stop-sequence overrides')
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1))
    throw new Error('Vibe output-token limit must be a positive integer')
  const system = [options.system, ...messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))].filter(Boolean).join('\n\n')
  return {
    system: `${system}\n\nYou supply one model step for DSH. The JSON input is the conversation history; continue from its last message. The dsh tool namespace exposes the available DSH tools. Request tools through that namespace. DSH executes them after this step and supplies results in the next request. Do not invent tool results.`,
    prompt: JSON.stringify(messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role, ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError ? { isError: true } : {}), content: message.content.filter(block => block.type !== 'reasoning'),
    }))),
  }
}

export function cliArguments(options, directory, socket) {
  return ['--yolo', '--disabled-tools', '*', '--max-turns', '1', '--time-limit', '300',
    '--agent-socket', socket, '--system-prompt-file', join(directory, 'system.txt'),
    '--output', 'streaming', '--output-dir', join(directory, 'output'),
    ...(options.model === 'default' ? [] : ['--model', options.model]), '-p']
}

function killGroup(child, signal) {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

/** Execute exactly one Vibe model step, collecting inert client-tool requests. */
export async function runStep(options, executable = process.env.VIBE_EXECUTABLE ?? 'vibe') {
  options.signal?.throwIfAborted()
  const input = requestInput(options)
  const directory = await mkdtemp(join(tmpdir(), 'dv-'))
  const socketPath = join(directory, 'a.sock')
  const pending = [], sockets = new Set()
  const toolNames = new Map()
  const tools = (options.tools ?? []).map((definition, index) => {
    let name = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(definition.name) ? `dsh_${definition.name}` : `tool_${index}`
    while (toolNames.has(`dsh.${name}`)) name = `_${name}`
    toolNames.set(`dsh.${name}`, definition.name)
    return { namespace: 'dsh', name, description: `${definition.name}: ${definition.description}`,
      inputSchema: definition.parameters, modelAccess: 'direct' }
  })
  let child, closed, deadline, escalation, fatal
  let stdout = '', stderr = ''
  const abort = () => {
    killGroup(child, 'SIGTERM')
    escalation ??= setTimeout(() => killGroup(child, 'SIGKILL'), 2000)
  }
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = '', handled = false
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_BYTES) { fatal = new Error('Vibe socket request exceeded limit'); socket.destroy(); abort(); return }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      try {
        const request = JSON.parse(buffer.slice(0, newline))
        const reply = { jsonrpc: '2.0', id: request.id }
        if (request.method === 'agent/initialize' && request.params?.protocolVersion === 2) {
          reply.result = { protocolVersion: 2, tools }
        } else if (request.method === 'tools/call' && toolNames.has(request.params?.name)) {
          const params = request.params
          if (params.caller?.parentSessionId) throw new Error('Unexpected Vibe subagent tool request')
          if (!params.toolCallId || typeof params.toolCallId !== 'string') throw new Error('Vibe tool request has no call ID')
          if (!Object.hasOwn(params, 'input')) throw new Error('Vibe tool request has no arguments')
          if (!pending.some(call => call.id === params.toolCallId)) pending.push({
            type: 'tool-call', id: params.toolCallId, name: toolNames.get(params.name), arguments: JSON.stringify(params.input),
          })
          // Official socket abort: no tool executes and Vibe exports outcome=aborted.
          reply.error = { code: -32002, message: HANDOFF }
        } else {
          throw new Error(`Unsupported Vibe socket request: ${request.method}`)
        }
        socket.end(JSON.stringify(reply) + '\n')
      } catch (error) {
        fatal = error
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32002, message: error.message } }) + '\n')
        abort()
      }
    })
  })
  try {
    const routing = [...toolNames].map(([alias, name]) => `${name} -> ${alias}`).join('\n')
    await writeFile(join(directory, 'system.txt'), `${input.system}\n\nExact tool routing:\n${routing}\nVibe native tools, including file_system.bash, are disabled. Use only the declared dsh namespace, even when the history mentions a bare tool name.`, { mode: 0o600 })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
    options.signal?.throwIfAborted()
    child = spawn(executable, cliArguments(options, directory, socketPath), {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, ...(options.maxTokens ? { VIBE_AGENT_MAX_OUTPUT_TOKENS: String(options.maxTokens) } : {}) },
    })
    closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (Buffer.byteLength(stdout) > MAX_BYTES) { stdout = stdout.slice(0, MAX_BYTES); fatal = new Error('Vibe output exceeded limit'); abort() }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048) })
    child.stdin.on('error', () => {})
    child.stdin.end(input.prompt)
    deadline = setTimeout(() => { fatal = new Error('Vibe CLI timed out'); abort() }, 310_000)
    const exit = await closed
    options.signal?.throwIfAborted()
    if (fatal) throw fatal
    let exported
    try { exported = JSON.parse(await readFile(join(directory, 'output/export.json'), 'utf8')) }
    catch { throw new Error(`Vibe CLI produced no valid export (exit ${exit.code}): ${stderr}`) }
    const handoff = pending.length > 0 && exit.code === 4 && exported.outcome === 'aborted' && exported.error?.message === HANDOFF
    const limited = exit.code === 3 && ['length', 'token_limit'].includes(exported.outcome)
    if (pending.length && !handoff) throw new Error('Vibe did not acknowledge the DSH tool handoff')
    if (!handoff && !limited && (exit.code !== 0 || exported.outcome !== 'finished'))
      throw new Error(`Vibe ${exported.outcome}: ${exported.error?.message ?? exported.stop_reason ?? `exit ${exit.code}`}`)
    const blocks = []
    for (const line of stdout.split(/\r?\n/u).filter(line => line.trim())) {
      const event = JSON.parse(line)
      if (event.generationStatus && event.generationStatus !== 'completed') continue
      if (event.type === 'reasoning' && event.text) blocks.push({ type: 'reasoning', text: event.text })
      else if (event.type === 'message' && event.role === 'assistant')
        for (const block of event.content ?? []) if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
    blocks.push(...pending)
    if (!blocks.length) throw new Error('Vibe finished without a reply or tool call')
    const usage = exported.usage
    return { blocks, usage: usage ? {
      inputTokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens), outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cached_input_tokens, totalTokens: usage.total_tokens,
    } : undefined, reason: { kind: handoff ? 'tool-calls' : limited ? 'max-tokens' : 'stop' } }
  } finally {
    clearTimeout(deadline)
    clearTimeout(escalation)
    options.signal?.removeEventListener('abort', abort)
    if (child && child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGKILL')
      await closed?.catch(() => {})
    }
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

export async function* streamStep(options, executable) {
  const response = await runStep(options, executable)
  for (const [index, block] of response.blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text }
    yield { type: 'block-end', index, block }
  }
  if (response.usage) yield { type: 'usage', usage: response.usage }
  yield { type: 'finish', reason: response.reason }
}
