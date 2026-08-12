import type { PsycheConfig, PsycheThemeName } from '../types.js';
import { createWelcomePane, welcomePaneExists, destroyWelcomePane } from './welcomePane.js';
import { LogService } from '../services/LogService.js';
import { mutateProjectPaneConfig } from '../services/ProjectPaneConfig.js';

// Global lock to prevent concurrent welcome pane operations
let creationLock = false;
let lastCreationTime = 0;
const CREATION_DEBOUNCE_MS = 500; // Wait 500ms after creation before allowing another

/**
 * Try to acquire the creation lock (for creating welcome panes)
 * This has a debounce to prevent duplicate creations
 */
function tryAcquireCreationLock(): boolean {
  const now = Date.now();

  // Check if we're within the debounce window
  if (now - lastCreationTime < CREATION_DEBOUNCE_MS) {
    return false;
  }

  // Check if lock is already held
  if (creationLock) {
    return false;
  }

  creationLock = true;
  return true;
}

/**
 * Release the creation lock
 */
function releaseCreationLock(): void {
  creationLock = false;
  lastCreationTime = Date.now();
}

/**
 * Destroy the welcome pane if it exists
 * This should be called when creating the first content pane
 * NO LOCK - destruction is always allowed and takes priority
 *
 * @param projectRoot - The project root directory
 * @returns true if destroyed successfully or no pane to destroy
 */
export async function destroyWelcomePaneCoordinated(projectRoot: string): Promise<boolean> {
  const logService = LogService.getInstance();

  try {
    await mutateProjectPaneConfig(projectRoot, async (configRecord) => {
      const config = configRecord as unknown as PsycheConfig;
      if (!config.welcomePaneId) {
        return;
      }

      await destroyWelcomePane(config.welcomePaneId);
      delete config.welcomePaneId;
      config.lastUpdated = new Date().toISOString();
    });
    return true;
  } catch (error) {
    logService.error('Failed to destroy welcome pane', 'WelcomePaneManager', undefined, error instanceof Error ? error : undefined);
    return false;
  }
}

/**
 * Create a welcome pane (coordinated with creation lock)
 * This should be called when closing the last content pane
 * Uses a debounced lock to prevent duplicate creations
 *
 * @param projectRoot - The project root directory
 * @param controlPaneId - The control pane ID
 * @returns true if created successfully, false if locked or failed
 */
export async function createWelcomePaneCoordinated(
  projectRoot: string,
  controlPaneId: string,
  themeName?: PsycheThemeName
): Promise<boolean> {
  const logService = LogService.getInstance();

  // Try to acquire creation lock
  if (!tryAcquireCreationLock()) {
    logService.debug('Could not acquire creation lock (debounce active)', 'WelcomePaneManager');
    return false;
  }

  try {
    let created = false;
    await mutateProjectPaneConfig(projectRoot, async (configRecord) => {
      const config = configRecord as unknown as PsycheConfig;
      if (config.welcomePaneId && await welcomePaneExists(config.welcomePaneId)) {
        created = true;
        return;
      }

      const welcomePaneId = await createWelcomePane(controlPaneId, projectRoot, themeName);
      if (!welcomePaneId) {
        return;
      }

      config.welcomePaneId = welcomePaneId;
      config.lastUpdated = new Date().toISOString();
      created = true;
    });
    return created;
  } catch (error) {
    logService.error('Failed to create welcome pane', 'WelcomePaneManager', undefined, error instanceof Error ? error : undefined);
    return false;
  } finally {
    releaseCreationLock();
  }
}

export async function syncWelcomePaneVisibility(
  projectRoot: string,
  controlPaneId: string | undefined,
  shouldShowWelcome: boolean,
  themeName?: PsycheThemeName
): Promise<boolean> {
  if (!controlPaneId) {
    return false;
  }

  const logService = LogService.getInstance();

  try {
    let synchronized = false;
    await mutateProjectPaneConfig(projectRoot, async (configRecord) => {
      const config = configRecord as unknown as PsycheConfig;
      const welcomePaneId = config.welcomePaneId;
      const hasLiveWelcomePane = welcomePaneId
        ? await welcomePaneExists(welcomePaneId)
        : false;

      if (shouldShowWelcome) {
        if (hasLiveWelcomePane) {
          synchronized = true;
          return;
        }

        const createdPaneId = await createWelcomePane(controlPaneId, projectRoot, themeName);
        if (!createdPaneId) {
          return;
        }
        config.welcomePaneId = createdPaneId;
        config.lastUpdated = new Date().toISOString();
        synchronized = true;
        return;
      }

      if (hasLiveWelcomePane && welcomePaneId) {
        await destroyWelcomePane(welcomePaneId);
      }
      delete config.welcomePaneId;
      config.lastUpdated = new Date().toISOString();
      synchronized = true;
    });
    return synchronized;
  } catch (error) {
    logService.error(
      'Failed to sync welcome pane visibility',
      'WelcomePaneManager',
      undefined,
      error instanceof Error ? error : undefined
    );
    return false;
  }
}

/**
 * LEGACY: Ensures a welcome pane exists when there are no psyche panes
 *
 * NOTE: This function is no longer used in normal operation.
 * Welcome pane management is now fully event-based:
 * - Created at startup (src/index.ts)
 * - Destroyed when first pane is created (paneCreation.ts)
 * - Recreated when last pane is closed (paneActions.ts)
 *
 * This function remains available for manual recovery or edge cases only.
 *
 * @param projectRoot - The project root directory
 * @param controlPaneId - The control pane ID
 * @param panesCount - Number of active psyche panes
 */
export async function ensureWelcomePane(
  projectRoot: string,
  controlPaneId: string | undefined,
  panesCount: number
): Promise<void> {
  const logService = LogService.getInstance();

  logService.debug(`ensureWelcomePane called: panesCount=${panesCount}, controlPaneId=${controlPaneId}`, 'WelcomePaneManager');

  // Only create welcome pane if there are no psyche panes
  if (panesCount > 0 || !controlPaneId) {
    logService.debug(`Skipping: panesCount > 0 (${panesCount}) or no controlPaneId (${controlPaneId})`, 'WelcomePaneManager');
    return;
  }

  // Use the coordinated creation function which respects the lock
  await createWelcomePaneCoordinated(projectRoot, controlPaneId);
}
