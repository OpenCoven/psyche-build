import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { renamePane } from '../../src/actions/implementations/renameAction.js';
import { TmuxService } from '../../src/services/TmuxService.js';
import { createMockPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectInput, expectSuccess } from '../helpers/actionAssertions.js';
import { readWorktreeMetadata } from '../../src/utils/worktreeMetadata.js';

const tempDirs: string[] = [];

describe('renameAction', () => {
  beforeEach(() => {
    vi.spyOn(TmuxService, 'getInstance').mockReturnValue({
      setPaneTitle: vi.fn(async () => {}),
    } as unknown as TmuxService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('prompts for a new pane name', async () => {
    const pane = createMockPane({
      slug: 'test-pane',
      displayName: 'Review Queue',
      worktreePath: undefined,
    });
    const context = createMockContext([pane]);

    const result = await renamePane(pane, context);

    expectInput(result);
    expect(result.title).toBe('Rename Pane');
    expect(result.defaultValue).toBe('Review Queue');
    expect(result.placeholder).toBe('test-pane');
  });

  it('saves a custom display name without changing the slug', async () => {
    const pane = createMockPane({
      slug: 'test-pane',
      worktreePath: undefined,
    });
    const savePanes = vi.fn(async () => {});
    const onPaneUpdate = vi.fn();
    const context = createMockContext([pane], { savePanes, onPaneUpdate });

    const result = await renamePane(pane, context);
    const submitResult = await result.onSubmit?.('QA Review');

    expect(submitResult).toBeDefined();
    expectSuccess(submitResult!, 'Renamed pane');
    expect(savePanes).toHaveBeenCalledTimes(1);
    expect(savePanes).toHaveBeenCalledWith([
      expect.objectContaining({
        id: pane.id,
        slug: 'test-pane',
        displayName: 'QA Review',
      }),
    ], [pane]);
    expect(onPaneUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pane.id,
        slug: 'test-pane',
        displayName: 'QA Review',
      })
    );
  });

  it('clears the custom display name when submitted blank', async () => {
    const pane = createMockPane({
      slug: 'test-pane',
      displayName: 'QA Review',
      worktreePath: undefined,
    });
    const savePanes = vi.fn(async () => {});
    const context = createMockContext([pane], { savePanes });

    const result = await renamePane(pane, context);
    const submitResult = await result.onSubmit?.('   ');

    expect(submitResult).toBeDefined();
    expectSuccess(submitResult!, 'Reset pane name');
    expect(savePanes).toHaveBeenCalledWith([
      expect.objectContaining({
        id: pane.id,
        slug: 'test-pane',
        displayName: undefined,
      }),
    ], [pane]);
  });

  it('persists worktree display names so reopened panes keep the rename', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-rename-worktree-'));
    tempDirs.push(worktreePath);
    const pane = createMockPane({
      slug: 'test-pane',
      worktreePath,
    });
    const context = createMockContext([pane], {
      savePanes: vi.fn(async () => {}),
    });

    const result = await renamePane(pane, context);
    const submitResult = await result.onSubmit?.('QA Review');

    expect(submitResult).toBeDefined();
    expectSuccess(submitResult!, 'Renamed pane');
    expect(readWorktreeMetadata(worktreePath)).toEqual(
      expect.objectContaining({
        displayName: 'QA Review',
      })
    );
  });
});
