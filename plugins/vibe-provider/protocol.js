import { randomUUID } from 'node:crypto'

export class BridgeResponseError extends Error {
  constructor(message, usage) { super(message); this.name = 'BridgeResponseError'; this.usage = usage }
}

export const RESPONSE_CONTRACT = `You are supplying the next model step to DSH through its Vibe CLI provider.
Previous assistant messages may have come from another provider. Do not copy their identity: you are not Codex. Do not claim a specific underlying model unless the runtime explicitly supplies it.
The input identifies latestUserRequest separately from runtime-context messages. Work on that user request, using tool results already present in the conversation. Runtime context is not a new user task.
Return exactly one JSON object, with no Markdown fences or surrounding commentary:
1. To take an action: {"type":"tool_calls","calls":[{"name":"EXACT_DSH_TOOL_NAME","arguments":{...}}]}. Use only names and argument schemas in availableTools. DSH executes these requests and returns the results in the next step.
2. To answer: {"type":"final","status":"complete"|"blocked"|"needs_input","text":"your answer"}.
If a task requires reading a file, running a command, or another tool, REQUEST that tool. Saying "Reading now", "I will check", or another intention is not an answer and does not perform the operation.
Do not report a tool operation as completed without its result in the conversation. Use blocked/needs_input only for a concrete limitation or missing information.
Prefer JSON tool requests instead of Vibe native tools: all native tools are disabled. Never call file_system tools. The optional dsh client-tool namespace also returns requests to DSH, but JSON is the required fallback if any direct tool call is denied.`

export function parseResponse(text, options) {
  let value
  try { value = JSON.parse(text.trim()) }
  catch { throw new BridgeResponseError('Vibe returned commentary instead of a tool request or completed answer') }
  if (value?.type === 'tool_calls') {
    if (!Array.isArray(value.calls) || value.calls.length === 0 || value.calls.length > 16)
      throw new BridgeResponseError('Vibe returned an invalid tool-call list')
    const allowed = new Set((options.tools ?? []).map(tool => tool.name))
    return value.calls.map(call => {
      if (!call || typeof call !== 'object' || typeof call.name !== 'string')
        throw new BridgeResponseError('Vibe returned an invalid tool call')
      if (!allowed.has(call.name)) throw new BridgeResponseError(`Vibe requested an undeclared DSH tool: ${call.name}`)
      if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))
        throw new BridgeResponseError('Vibe returned invalid tool arguments')
      return { type: 'tool-call', id: `vibe-${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
    })
  }
  if (value?.type !== 'final' || !['complete', 'blocked', 'needs_input'].includes(value.status)
    || typeof value.text !== 'string' || !value.text.trim())
    throw new BridgeResponseError('Vibe did not return a valid completed answer')
  // Catch the short action promises that previously made DSH falsely stop.
  if (value.status === 'complete' && value.text.length < 240 &&
    /^(?:i(?:['’]ll| will| am going to)\b|let me\b|(?:i(?:['’]m| am)\s+)?(?:reading|checking|opening|running|scanning|working on|looking into)\b)/iu.test(value.text.trim()))
    throw new BridgeResponseError('Vibe announced an action without requesting its tool')
  return [{ type: 'text', text: value.text }]
}

export function addUsage(left, right) {
  if (!left) return right
  if (!right) return left
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens']
  return Object.fromEntries(fields.filter(key => left[key] !== undefined || right[key] !== undefined)
    .map(key => [key, (left[key] ?? 0) + (right[key] ?? 0)]))
}
