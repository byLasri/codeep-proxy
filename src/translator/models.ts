// Mapping from OpenAI model names to DeepSeek wire protocol model_type values.
// According to DeepSeek-API.md, the wire protocol uses:
//   null for Default / Instant (Flash V4.1)
//   "expert" for Expert / Pro (V4)
// Note: "default" is a settings value and not a valid completion request value.

/**
 * Map an OpenAI model string to the DeepSeek model_type for wire protocol.
 * @param model OpenAI model name (e.g., "V4.1-flash", "V4-Pro") or null/undefined.
 * @returns DeepSeek model_type: null for flash, "expert" for pro, null for unknown or non-string.
 */
export function mapOpenAIModelToDeepSeek(modelType: unknown): null | 'expert' {
  if (typeof modelType !== 'string') {
    return null;
  }
  // Normalize to lower case for case-insensitive comparison? The spec doesn't specify,
  // but we'll assume the exact strings as given.
  if (modelType === 'V4-Pro') {
    return 'expert';
  }
  // For "V4.1-flash" and any other model, we return null (flash/default).
  return null;
}