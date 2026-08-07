import { useEffect, useState } from 'react';
import type { ProjectSettings } from '../types.js';
import {
  mutateProjectPaneSettings,
  projectRootFromPaneConfigPath,
  readProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';

export default function useProjectSettings(settingsFile: string) {
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({});

  useEffect(() => {
    const load = async () => {
      try {
        const projectRoot = projectRootFromPaneConfigPath(settingsFile);
        if (!projectRoot) {
          throw new Error(`Settings file is not a project pane config: ${settingsFile}`);
        }
        const parsed = await readProjectPaneConfig(projectRoot);

        // Handle both old format (direct settings) and new format (config with settings field)
        if (parsed.settings !== undefined || parsed.panes !== undefined) {
          // New config format
          setProjectSettings((parsed.settings || {}) as ProjectSettings);
        } else {
          // Old format or direct settings
          setProjectSettings(parsed as ProjectSettings);
        }
      } catch {
        setProjectSettings({});
      }
    };
    load();
  }, [settingsFile]);

  const saveSettings = async (settings: ProjectSettings) => {
    const projectRoot = projectRootFromPaneConfigPath(settingsFile);
    if (!projectRoot) {
      throw new Error(`Settings file is not a project pane config: ${settingsFile}`);
    }

    await mutateProjectPaneSettings(projectRoot, (currentSettings) => {
      Object.assign(currentSettings, settings);
    });
    setProjectSettings(settings);
  };

  return { projectSettings, saveSettings };
}
