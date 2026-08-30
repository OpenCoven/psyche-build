import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile action executor registration', () => {
  it('registers once from live refs and unregisters during teardown', () => {
    const source = readFileSync('src/PsycheApp.tsx', 'utf8');
    expect(source).toContain('const mobileActionStateRef = useRef({');
    expect(source).toContain('const live = mobileActionStateRef.current');
    expect(source).toContain('panes: live.panes');
    expect(source).toContain('savePanes: live.savePanes');
    expect(source).toContain('sessionProjectRoot,');
    expect(source).toContain('getTmuxServerIdentity: () => TmuxService.getInstance().getServerIdentity?.(),');
    expect(source).toContain('onPaneUpdate: (updatedPane) =>');
    expect(source).toContain('onPaneRemove: (removedPaneId) =>');
    expect(source).toContain('bridgeDaemon.setActionExecutor(async');
    expect(source).toContain('return () => bridgeDaemon.setActionExecutor(null)');
    expect(source).toMatch(
      /return \(\) => bridgeDaemon\.setActionExecutor\(null\)\s*\n\s*}, \[bridgeDaemon, projectName, sessionName, sessionProjectRoot, setPanes\]\)/,
    );
  });

  it('clears the device-owned continuation sessions on disconnect', () => {
    const source = readFileSync('src/services/bridge/BridgeDaemon.ts', 'utf8');
    expect(source).toContain(
      'this.mobileGateway?.clearOwner(this.ownerIdForSession(s));',
    );
    expect(source).toMatch(/private ownerIdForSession[\s\S]*return s\.connectionId;/);
    expect(source).toContain('if (!executor) this.mobileGateway?.clearActions();');
  });
});
