export interface ModelConfig {
  model_type: null | 'expert'
  thinking: boolean
  search: boolean
}

export function mapOpenAIModelToDeepSeek(model: unknown): ModelConfig {
  if (typeof model !== 'string') {
    return { model_type: null, thinking: false, search: false }
  }
  // Flash (null) variants
  if (model === 'V4.1-flash-DeepThink') return { model_type: null, thinking: true, search: false }
  if (model === 'V4.1-flash-DeepThink-Web') return { model_type: null, thinking: true, search: true }
  if (model === 'V4.1-flash-Standard') return { model_type: null, thinking: false, search: false }
  if (model === 'V4.1-flash-Standard-Web') return { model_type: null, thinking: false, search: true }
  // Pro (expert) variants — no web search
  if (model === 'V4-Pro-DeepThink') return { model_type: 'expert', thinking: true, search: false }
  if (model === 'V4-Pro-Standard') return { model_type: 'expert', thinking: false, search: false }
  // Base names default to Standard
  if (model === 'V4.1-flash' || model === 'gpt-3.5-turbo') {
    return { model_type: null, thinking: false, search: false }
  }
  if (model === 'V4-Pro' || model === 'deepseek-v4-pro') {
    return { model_type: 'expert', thinking: false, search: false }
  }
  // Unknown -> Flash Standard
  return { model_type: null, thinking: false, search: false }
}
