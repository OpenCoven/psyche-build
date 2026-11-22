import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const views = new URL('../native/ios/PsycheApp/Sources/PsycheApp/Views/', import.meta.url);
const composer = readFileSync(new URL('PaneComposer.swift', views), 'utf8');
const workspace = readFileSync(new URL('PaneWorkspaceView.swift', views), 'utf8');

// These are source-wiring guards, not a substitute for the native composer
// tests or physical rotation acceptance. The pure target predicate was already
// correct in #539; the defect was passing persisted, rather than rendered, IDs.
describe('iOS composer rendered-pane boundary (#538 / #539)', () => {
  it('requires the layout projection instead of inferring visibility from stored selection', () => {
    assert.match(composer, /private let shownPaneIDs: \[String\?\]/);
    assert.match(composer, /init\(sendAttempts: PaneComposerSendAttempts, shownPaneIDs: \[String\?\]\)/);
    assert.match(composer, /shownPaneIDs: shownPaneIDs/);
    assert.doesNotMatch(composer, /shownPaneIDs: \[store\.primaryPaneID, store\.secondaryPaneID\]/);
  });

  it('includes the secondary only when the same layout renders the split', () => {
    assert.match(workspace, /let showsSplit = hasRoomForTwo && secondaryPane != nil/);
    assert.match(workspace, /let shownPaneIDs: \[String\?\] = \[primaryPane\?\.id, showsSplit \? secondaryPane\?\.id : nil\]/);
    assert.match(workspace, /PaneComposer\(\s*sendAttempts: appModel\.paneComposerSendAttempts,\s*shownPaneIDs: shownPaneIDs\s*\)/);
  });

  it('moves focus off a hidden pane without discarding the retained split selection', () => {
    const callback = workspace.match(/\.onChange\(of: shownPaneIDs, initial: true\) \{ _, shown in([\s\S]*?)\n            \}/)?.[1];
    assert.ok(callback, 'Rendered-pane changes must reconcile hidden focus');
    assert.match(callback, /!shown\.contains\(focused\)/);
    assert.match(callback, /let primary = primaryPane\?\.id/);
    assert.match(callback, /registry\.focus\(primary\)/);
    assert.doesNotMatch(callback, /store\.secondaryPaneID\s*=/);
  });

  it('selects a hidden secondary as primary instead of focusing the invisible terminal', () => {
    assert.match(workspace, /onSelect: \{ select\(\$0, showsSplit: showsSplit\) \}/);
    assert.match(workspace, /if showsSplit && store\.secondaryPaneID == paneID/);
  });
});
