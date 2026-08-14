export const AGENT_CONTROL_UI_LIMITS = Object.freeze({
  cardsPerGroup: 100,
  resourcesPerCard: 32,
  capabilitiesPerResource: 12,
  registeredResources: 256,
  textBytes: 128,
  capabilityBytes: 64,
});

const encoder = new TextEncoder();

export function boundedAgentControlText(value, byteLimit = AGENT_CONTROL_UI_LIMITS.textBytes) {
  const text = String(value ?? '');
  if (encoder.encode(text).byteLength <= byteLimit) return text;
  let result = '';
  for (const character of text) {
    if (encoder.encode(`${result}${character}…`).byteLength > byteLimit) break;
    result += character;
  }
  return `${result}…`;
}

export function boundedAgentControlList(value, limit) {
  const list = Array.isArray(value) ? value : [];
  return { items: list.slice(0, limit), overflow: Math.max(0, list.length - limit) };
}
