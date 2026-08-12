import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import PanesGrid from '../src/components/panes/PanesGrid.js';

describe('PanesGrid collapse control', () => {
  it('renders the expanded collapse chevron on the first line', () => {
    const { lastFrame } = render(
      <PanesGrid
        panes={[]}
        selectedIndex={0}
        isLoading={false}
        themeName="purple"
        projectThemeByRoot={new Map()}
        sidebarProjects={[]}
        fallbackProjectRoot="/repo"
        fallbackProjectName="repo"
        showCollapseControl
      />
    );

    const firstLine = stripAnsi(lastFrame() ?? '').split('\n')[0] ?? '';
    expect(firstLine).toContain('‹');
  });
});
