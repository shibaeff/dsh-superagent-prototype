import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const PROVIDER = 'claude-code'
const SERVER = 'dsh'

/** Claude owns sign-in. No credentials file/keychain access or raw HTTP. */
export function sdkOptions(controller, environment = process.env) {
  const env = { ...environment }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY']) delete env[key]
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'dsh-claude-code-provider/0.1.0'
  const executable = environment.CLAUDE_CODE_EXECUTABLE ?? join(homedir(), '.local/bin/claude')
  return {
    env, abortController: controller,
    ...(existsSync(executable) ? { pathToClaudeCodeExecutable: executable } : {}),
    tools: [], mcpServers: {}, strictMcpConfig: true,
    settingSources: [], plugins: [], persistSession: false,
    permissionMode: 'default',
    // Tools exposed below only describe requests for DSH to execute. Even
    // if the SDK asks to execute one, it must never perform the operation.
    canUseTool: async () => ({ behavior: 'deny', message: 'DSH executes tools after this model step.' }),
  }
}

/** Query the official CLI's catalog without sending a model prompt. */
export async function discoverModels(runQuery = query) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const stream = runQuery({
    prompt: (async function* () {
      await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))
    })(),
    options: sdkOptions(controller),
  })
  try {
    const models = await stream.supportedModels()
    return models.filter(model => !model.value.includes('plan'))
  } finally {
    clearTimeout(timer)
    controller.abort()
    stream.close()
  }
}

/** Preserve DSH roles and tool-result IDs when starting a new SDK step. */
export function transcript(options) {
  const messages = options.messages ?? []
  for (const message of messages) {
    if (message.content.some(block => block.type === 'image' || block.type === 'file'))
      throw new Error('Claude Code provider currently accepts text and tool results; use /claude for image input.')
  }
  const system = [options.system, ...messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))]
    .filter(Boolean).join('\n\n')
  const conversation = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.isError ? { isError: true } : {}),
    content: message.content.filter(block => block.type !== 'reasoning'),
  }))
  return {
    system: `${system}\n\nYou supply one model step for the DSH agent. The JSON below is its conversation history, in order. Continue from the last message. Tools exposed through the dsh MCP server are declarations: DSH will execute your tool calls and supply their results on the next step. Do not invent results or execute tools yourself.`,
    prompt: JSON.stringify(conversation),
  }
}

/** SDK MCP handlers are inert; only DSH executes the returned tool calls. */
export function toolServer(definitions = []) {
  const names = new Map()
  const tools = definitions.map((definition, index) => {
    const alias = `tool_${index}`
    names.set(`mcp__${SERVER}__${alias}`, definition.name)
    const schema = z.fromJSONSchema(definition.parameters)
    if (!schema.shape) throw new Error(`Tool ${definition.name} must have an object parameter schema`)
    return tool(alias, `${definition.name}: ${definition.description}`, schema.shape, async () => ({
      isError: true, content: [{ type: 'text', text: 'Pending execution by DSH; no operation was performed here.' }],
    }))
  })
  return { names, server: createSdkMcpServer({ name: SERVER, version: '0.1.0', tools }) }
}

function* blockChunks(index, block) {
  yield { type: 'block-start', index, blockType: block.type }
  if (block.type === 'tool-call') {
    yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
  } else {
    yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text }
  }
  yield { type: 'block-end', index, block }
}

function usageChunk(usage) {
  return { type: 'usage', usage: {
    inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  } }
}

/** Stop the SDK at its first tool request, before DSH executes anything. */
export async function* streamStep(options, runQuery = query) {
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 300_000)
  let stream
  try {
    const { prompt, system } = transcript(options)
    const { names, server } = toolServer(options.tools)
    const baseOptions = sdkOptions(controller)
    stream = runQuery({ prompt, options: {
      ...baseOptions, model: options.model, systemPrompt: system,
      mcpServers: { [SERVER]: server }, maxTurns: 1,
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      ...(options.maxTokens ? { env: { ...baseOptions.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) } } : {}),
    } })
    let index = 0
    for await (const message of stream) {
      options.signal?.throwIfAborted()
      if (message.type === 'assistant') {
        if (message.error) throw new Error(`Claude Code returned ${message.error}`)
        let calls = 0
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            const name = names.get(block.name)
            if (!name) throw new Error(`Claude requested an unavailable tool: ${block.name}`)
            yield* blockChunks(index++, { type: 'tool-call', id: block.id, name, arguments: JSON.stringify(block.input) })
            calls++
          } else if (block.type === 'text') {
            yield* blockChunks(index++, { type: 'text', text: block.text })
          } else if (block.type === 'thinking') {
            yield* blockChunks(index++, { type: 'reasoning', text: block.thinking })
          }
        }
        if (calls) {
          yield usageChunk(message.message.usage)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      } else if (message.type === 'result') {
        if (message.is_error) throw new Error(`Claude Code: ${(message.errors ?? [message.subtype]).join('; ')}`)
        yield usageChunk(message.usage)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    }
    throw new Error('Claude Code ended without a model result')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    stream?.close()
  }
}
