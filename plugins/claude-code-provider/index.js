import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { discoverModels, streamStep, PROVIDER } from './bridge.js'

export const name = 'llm-claude-code'
export const inject = ['llm']

export class ClaudeCodeAdapter extends LlmAdapter {
  #models
  async catalog() {
    this.#models ??= discoverModels().catch(error => { this.#models = undefined; throw error })
    return this.#models
  }
  providerInfo(provider) { return { id: provider, name: 'Claude Code (subscription)' } }
  async listModels(provider) {
    return (await this.catalog()).map(model => ({
      provider, id: model.value, name: model.displayName,
      description: model.description, inputModalities: ['text'],
    }))
  }
  async resolveModel(provider, id) {
    const models = await this.catalog()
    const model = models.find(model => model.value === id || model.resolvedModel === id)
    if (!model) throw new LlmError(`Claude Code does not list model ${id}`, 'MODEL_NOT_FOUND')
    const efforts = model.supportedEffortLevels ?? []
    return {
      provider, id, name: model.displayName, inputModalities: ['text'],
      ...(efforts.length ? { reasoning: { efforts: efforts.map(id => ({ id, name: id })),
        defaultEffort: efforts.includes('high') ? 'high' : efforts[0] } } : {}),
    }
  }
  async *stream(options) {
    try { yield* streamStep(options) }
    catch (error) {
      throw new LlmError(error.message, options.signal?.aborted ? 'ABORTED' : 'CLAUDE_CODE_ERROR', { cause: error })
    }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new ClaudeCodeAdapter())
}
