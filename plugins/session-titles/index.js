import { executeSessionTitleLlm } from '@deepseek-ai/dsh-session-title-llm'
import { createProvider, TITLE_SYSTEM } from './policy.js'

export const name = 'adaptive-session-titles'
export const inject = ['sessionTitle', 'llm', 'sessions']

export function apply(ctx) {
  const provider = createProvider(async (request, prepared) => {
    // Keep title data on the user's selected provider. Claude's short tasks
    // use its fast subscription model rather than the main agent's effort.
    const route = request.route?.provider === 'claude-code'
      ? { provider: 'claude-code', model: 'haiku' } : request.route
    return executeSessionTitleLlm(ctx, {
      maxInputBytes: 8192, maxOutputTokens: 1024, timeoutMs: 60000, ...route,
    }, request, 'adaptive-session-titles', {
      system: TITLE_SYSTEM, input: prepared.input, messageSeqs: prepared.messageSeqs,
      selectReasoningEffort: model => model.reasoning?.efforts[0]?.id,
    })
  })
  ctx.sessionTitle.register(provider)
}
