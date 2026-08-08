import {
  spawnBridgePane,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
} from '../../daemon/bridge.js';
import {
  createPane,
  type CreatePaneOptions,
  type CreatePaneResult,
} from '../../utils/paneCreation.js';

export type {
  BridgeSpawnRequest,
  BridgeSpawnResult,
  CreatePaneOptions,
  CreatePaneResult,
};

/**
 * Effect boundary for pane creation.
 *
 * The orchestration backends are pure policy/translation units; they must not
 * import pane-mutation effects directly. This module is the single place that
 * constructs those capabilities, so a backend can only reach a real effect
 * through an explicitly injected (or defaulted-from-here) capability.
 */
export const defaultSpawnPane = spawnBridgePane;
export const defaultCreatePane = createPane;
