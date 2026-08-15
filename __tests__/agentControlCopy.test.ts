import { describe, expect, it } from 'vitest';
import { AGENT_CONTROL_GENERIC_CLICK_LIMITATION } from '../native/desktop/psyche-build-tauri/web/control/agent-control-copy.mjs';
import { TOOLS } from '../src/mcp/server.js';

describe('agent control operator copy', () => {
  it('keeps the drawer and MCP generic-click limitation synchronized', () => {
    expect(AGENT_CONTROL_GENERIC_CLICK_LIMITATION).toBe(
      'Application-defined effects behind a generic click cannot be perfectly predicted.',
    );
    expect(TOOLS.find((tool) => tool.name === 'psyche_browser_action')?.description)
      .toContain(AGENT_CONTROL_GENERIC_CLICK_LIMITATION);
  });
});
