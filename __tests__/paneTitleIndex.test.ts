import { describe, expect, it } from 'vitest';
import { indexUniquePaneTitles } from '../src/utils/paneTitleIndex.js';

describe('pane title indexing', () => {
  it('indexes unique managed titles one-to-one and rejects ambiguous legacy titles', () => {
    const indexed = indexUniquePaneTitles([
      { paneId: '%1', title: 'Fix bug · fix-bug' },
      { paneId: '%2', title: 'Fix bug · fix-bug-2' },
      { paneId: '%3', title: 'legacy duplicate' },
      { paneId: '%4', title: 'legacy duplicate' },
    ]);

    expect(indexed.allPaneIds).toEqual(['%1', '%2', '%3', '%4']);
    expect(indexed.titleToId).toEqual(new Map([
      ['Fix bug · fix-bug', '%1'],
      ['Fix bug · fix-bug-2', '%2'],
    ]));
  });
});
