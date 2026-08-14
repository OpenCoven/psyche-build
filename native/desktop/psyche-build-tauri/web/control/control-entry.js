export { browserAutomationSource, dispatchBrowserAutomation, installBrowserAutomation } from './browser-automation.mjs';
export { badgeAccessibleName, normalizeAgentControlState, resourceBadgeFor, resourceBadgesFor } from './agent-control-model.mjs';
export { createAgentControlDrawer } from './agent-control-drawer.mjs';
export { createAgentControlPoller } from './agent-control-poller.mjs';
export const GENERIC_CLICK_LIMITATION =
  'Application-defined effects behind a generic click cannot be perfectly predicted.';
