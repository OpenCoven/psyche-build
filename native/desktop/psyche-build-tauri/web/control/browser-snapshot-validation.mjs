const MAX_VISITED = 2000; const MAX_NODES = 2000; const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 512; const MAX_URL_BYTES = 2048;
const APPROVED_ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox', 'heading',
  'img', 'iframe', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'list', 'listitem',
  'tab', 'tablist', 'menu', 'menuitem', 'dialog', 'alert', 'status', 'searchbox', 'spinbutton', 'slider'];
function invalid() { const error = new Error('browser snapshot failed trusted validation'); error.code = 'invalid_snapshot'; throw error; }
function bytes(value) { return new TextEncoder().encode(value).byteLength; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000; }

export function validateBrowserSnapshot(value, expected) {
  const topKeys = ['schema', 'snapshotId', 'documentId', 'tabId', 'generation', 'url', 'title', 'loading',
    'capturedAt', 'viewport', 'nodes', 'visited', 'truncated'];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== topKeys.length ||
      !topKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== 'psyche.browser.snapshot/v1' ||
      value.tabId !== expected.tabId || value.generation !== expected.generation || value.documentId !== expected.documentId ||
      typeof value.snapshotId !== 'string' || !value.snapshotId || bytes(value.snapshotId) > 256 ||
      typeof value.url !== 'string' || bytes(value.url) > MAX_URL_BYTES || typeof value.title !== 'string' || bytes(value.title) > MAX_NAME_BYTES ||
      typeof value.loading !== 'boolean' || !Number.isFinite(value.capturedAt) || value.capturedAt < 0 ||
      !value.viewport || !finite(value.viewport.width) || value.viewport.width < 0 || !finite(value.viewport.height) || value.viewport.height < 0 ||
      !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES || !Number.isInteger(value.visited) ||
      value.visited < value.nodes.length || value.visited > MAX_VISITED || typeof value.truncated !== 'boolean') invalid();
  for (let index = 0; index < value.nodes.length; index += 1) {
    const node = value.nodes[index]; const keys = node && Object.keys(node); const count = node && node.opaque === undefined ? 6 : 7;
    if (!node || typeof node !== 'object' || node.ref !== `e${index + 1}` || keys.length !== count ||
        !['ref', 'depth', 'role', 'name', 'state', 'bounds'].every((key) => Object.prototype.hasOwnProperty.call(node, key)) ||
        (count === 7 && !Object.prototype.hasOwnProperty.call(node, 'opaque')) || !APPROVED_ROLES.includes(node.role) ||
        typeof node.name !== 'string' || bytes(node.name) > MAX_NAME_BYTES || !Number.isInteger(node.depth) || node.depth < 0 || node.depth > MAX_DEPTH ||
        !node.state || typeof node.state !== 'object' || Array.isArray(node.state) ||
        (node.opaque !== undefined && typeof node.opaque !== 'boolean') || !node.bounds ||
        !['x', 'y', 'width', 'height'].every((key) => finite(node.bounds[key])) || node.bounds.width < 0 || node.bounds.height < 0) invalid();
    for (const [key, state] of Object.entries(node.state)) {
      if (!['disabled', 'checked', 'value', 'level', 'secret', 'valuePresent'].includes(key) ||
          (key === 'value' ? typeof state !== 'string' || bytes(state) > MAX_NAME_BYTES :
            key === 'level' ? !Number.isInteger(state) || state < 1 || state > 6 : typeof state !== 'boolean')) invalid();
    }
    if (node.state.secret === true && (Object.keys(node.state).some((key) => !['secret', 'valuePresent'].includes(key)) ||
        typeof node.state.valuePresent !== 'boolean')) invalid();
  }
  return value;
}
