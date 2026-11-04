import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { models, streamStep, PROVIDER } from './bridge.js'

export const name = 'llm-vibe-cli'
export const inject = ['llm']

export class VibeAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Vibe CLI (YOLO)' } }
  async listModels(provider) { return models().map(model => ({ ...model, provider, inputModalities: ['text'] })) }
  async resolveModel(provider, id) {
    const model = models().find(model => model.id === id)
    if (!model) throw new LlmError(`Vibe model alias ${id} is not configured; set DSH_VIBE_MODELS`, 'MODEL_NOT_FOUND')
    return { ...model, provider, inputModalities: ['text'] }
  }
  async *stream(options) {
    try { yield* streamStep(options) }
    catch (error) { throw new LlmError(error.message, options.signal?.aborted ? 'ABORTED' : 'VIBE_CLI_ERROR', { cause: error }) }
  }
}

export function apply(ctx) { ctx.llm.registerAdapter([PROVIDER], new VibeAdapter()) }
