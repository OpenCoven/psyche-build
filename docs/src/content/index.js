/**
 * Content registry - all pages and section definitions
 */

import * as introduction from './introduction.js';
import * as gettingStarted from './getting-started.js';
import * as features from './features.js';
import * as coreConcepts from './core-concepts.js';
import * as workflows from './workflows.js';
import * as keyboardShortcuts from './keyboard-shortcuts.js';
import * as merging from './merging.js';
import * as hooks from './hooks.js';
import * as configuration from './configuration.js';
import * as agents from './agents.js';
import * as multiAgent from './multi-agent.js';
import * as multiProject from './multi-project.js';
import * as remoteAccess from './remote-access.js';
import * as troubleshooting from './troubleshooting.js';

const modules = {
  introduction,
  'getting-started': gettingStarted,
  features,
  'core-concepts': coreConcepts,
  workflows,
  'keyboard-shortcuts': keyboardShortcuts,
  merging,
  hooks,
  configuration,
  agents,
  'multi-agent': multiAgent,
  'multi-project': multiProject,
  'remote-access': remoteAccess,
  troubleshooting,
};

export const sections = [
  {
    title: 'Overview',
    pages: [
      { path: '/introduction', title: 'Introduction' },
      { path: '/getting-started', title: 'Getting Started' },
      { path: '/features', title: 'Feature Map' },
    ],
  },
  {
    title: 'Usage',
    pages: [
      { path: '/core-concepts', title: 'Core Concepts' },
      { path: '/workflows', title: 'Workflows' },
      { path: '/keyboard-shortcuts', title: 'Keyboard Shortcuts' },
      { path: '/merging', title: 'Merging' },
    ],
  },
  {
    title: 'Advanced',
    pages: [
      { path: '/hooks', title: 'Hooks' },
      { path: '/configuration', title: 'Configuration' },
      { path: '/agents', title: 'Agents' },
      { path: '/multi-agent', title: 'Multi-Agent' },
      { path: '/multi-project', title: 'Multi-Project' },
      { path: '/remote-access', title: 'Docs Preview' },
      { path: '/troubleshooting', title: 'Troubleshooting' },
    ],
  },
];

// Add load function to each page
for (const section of sections) {
  for (const page of section.pages) {
    const key = page.path.slice(1);
    page.load = () => Promise.resolve(modules[key]);
  }
}
