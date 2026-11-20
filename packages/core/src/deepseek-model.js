export function isDeepSeekModel(model) {
  if (typeof model !== 'string') return false;
  const name = model.trim().split('/').at(-1);
  return /^deepseek(?:$|[-_.])/i.test(name);
}
