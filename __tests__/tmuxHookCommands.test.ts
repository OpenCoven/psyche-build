import { describe, expect, it } from 'vitest';
import {
  buildPaneExitedHookCommandForSession,
  buildPaneFocusHookCommandForSession,
} from '../src/utils/tmuxHookCommands.js';

describe('tmuxHookCommands', () => {
  it('builds pane-exited hook with recovery + SIGUSR2 notification', () => {
    const command = buildPaneExitedHookCommandForSession(4321, 'psyche-test');

    // base64 of 'psyche-test' — encoded, so a text sweep cannot rename it
    expect(command).toContain('PSYCHE_RECOVERY_SESSION_B64=cHN5Y2hlLXRlc3Q=');
    expect(command).toContain('PSYCHE_RECOVERY_EXITED_PANE=#{hook_pane}');
    expect(command).toContain('controlPaneRecovery.js');
    expect(command).toContain('kill -USR2 4321');
    expect(command).toContain('# psyche-hook');
  });

  it('encodes shell-sensitive session names safely', () => {
    const sessionName = 'my"session$`x\\y';
    const command = buildPaneExitedHookCommandForSession(1, sessionName);
    const encodedSession = Buffer.from(sessionName, 'utf-8').toString('base64');

    expect(command).toContain(`PSYCHE_RECOVERY_SESSION_B64=${encodedSession}`);
  });

  it('builds pane-focus hook without shelling out to tmux', () => {
    const command = buildPaneFocusHookCommandForSession('my"session$`x\\y', 99);

    expect(command).toContain('if-shell -F "#{!=:#{@psyche_active_border_style},}"');
    expect(command).toContain('set-option -F -t \\"my\\"session\\$\\`x\\\\y\\" pane-active-border-style');
    expect(command).toContain('#{@psyche_active_border_style}');
    expect(command).toContain('run-shell -b "kill -USR2 99 2>/dev/null || true # psyche-hook"');
    expect(command).not.toContain('show-options -p -v');
  });
});
