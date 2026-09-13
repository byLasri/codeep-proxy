import type { DeepSeekModelType } from '../deepseek_api/types.js'

export function mapOpenAIModelToDeepSeek(model: unknown): null | 'expert' {
  if (typeof model !== 'string') {
    return null
  }
  if (model === 'V4-Pro') {
    return 'expert'
  }
  return null
}
