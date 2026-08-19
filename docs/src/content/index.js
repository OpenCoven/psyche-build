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

export const modules = {
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

const canonicalNavigationPath = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function internalNavigationTargets(rendered) {
  return [...rendered.matchAll(/href\s*=\s*["']#(\/?[^"'?\s]+)["']/g)].map((match) => {
    const target = match[1];
    return target.startsWith('/') ? target : `/${target}`;
  });
}

export function validateNavigationGraph({
  modules: registryModules,
  sections: navigationSections,
  renderedEntries: additionalRenderedEntries = [],
}) {
  const failures = [];
  const navigationKeys = new Set();
  const renderedNavigationEntries = [];

  for (const section of navigationSections) {
    for (const page of section.pages) {
      if (!canonicalNavigationPath.test(page.path)) {
        failures.push(`navigation path "${page.path}": must use canonical /key form`);
        continue;
      }

      const key = page.path.slice(1);
      if (navigationKeys.has(key)) {
        failures.push(`navigation target "${page.path}": duplicate navigation key "${key}"`);
        continue;
      }
      navigationKeys.add(key);

      const contentModule = registryModules[key];
      if (!contentModule) {
        failures.push(`navigation target "${page.path}": content module "${key}" is missing`);
        continue;
      }
      if (typeof contentModule.render !== 'function') {
        failures.push(`navigation target "${page.path}": render entry is missing`);
        continue;
      }

      let rendered;
      try {
        rendered = contentModule.render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`navigation target "${page.path}": render() threw: ${message}`);
        continue;
      }
      if (typeof rendered !== 'string' || rendered.trim().length === 0) {
        failures.push(`navigation target "${page.path}": render() must return non-empty HTML`);
        continue;
      }
      renderedNavigationEntries.push({
        label: `navigation target "${page.path}"`,
        rendered,
      });
    }
  }

  for (const key of Object.keys(registryModules)) {
    if (!navigationKeys.has(key)) {
      failures.push(`module "${key}": no navigation page resolves to this key`);
    }
  }

  for (const entry of additionalRenderedEntries) {
    if (typeof entry?.source !== 'string' || typeof entry?.rendered !== 'string') {
      failures.push('navigation source: rendered entry must include string source and rendered values');
      continue;
    }
    renderedNavigationEntries.push({
      label: `navigation source "${entry.source}"`,
      rendered: entry.rendered,
    });
  }

  for (const entry of renderedNavigationEntries) {
    for (const target of internalNavigationTargets(entry.rendered)) {
      if (!navigationKeys.has(target.slice(1))) {
        failures.push(`${entry.label}: internal target "${target}" does not resolve`);
      }
    }
  }

  return [...new Set(failures)].sort();
}

// Add load function to each page
for (const section of sections) {
  for (const page of section.pages) {
    const key = page.path.slice(1);
    page.load = () => Promise.resolve(modules[key]);
  }
}
