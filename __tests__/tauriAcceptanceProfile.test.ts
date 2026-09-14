import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(new URL(
  `../native/desktop/psyche-build-tauri/${path}`, import.meta.url,
), 'utf8');
const main = read('web/main.js');
const app = read('src-tauri/src/app.rs');
const lib = read('src-tauri/src/lib.rs');
const profile = read('src-tauri/src/acceptance.rs');

function body(name: string) {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf('\n  function ', start + 1);
  return main.slice(start, end).trim();
}

describe('explicit native acceptance profile', () => {
  it('does not poll providers in acceptance, preserving ordinary polling', () => {
    for (const acceptance of [true, false]) {
      const stop = vi.fn();
      const refresh = vi.fn();
      const interval = vi.fn();
      const start = Function('state', 'document', 'stopCovenPolling',
        'refreshCovenSessions', 'setInterval', 'COVEN_POLL_MS',
        `let covenPollTimer; return (${body('startCovenPolling')});`)(
        { env: { acceptance_profile: acceptance }, projects: [{}] },
        { visibilityState: 'visible' }, stop, refresh, interval, 1000,
      );
      start();
      expect(stop).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledTimes(acceptance ? 0 : 1);
      expect(interval).toHaveBeenCalledTimes(acceptance ? 0 : 1);
    }
  });

  it('suppresses automatic skill discovery and provider publication before IPC', async () => {
    const invoke = vi.fn();
    const skills = Function('state', 'invoke', `return (${body('loadAgentSkills')});`)(
      { env: { acceptance_profile: true } }, invoke,
    );
    skills();
    const provider = Function('state', 'invoke',
      `return (${body('ensureBrowserControlProvider')});`)(
      { env: { acceptance_profile: true } }, invoke,
    );
    await expect(provider({ root: '/fixture' })).rejects.toThrow('disabled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('configures persistent isolated stores before any main or child WebView creation', () => {
    expect(app.indexOf('acceptance::initialize')).toBeLessThan(app.indexOf('tauri::Builder::default'));
    expect(app).toContain('window.create = false');
    expect(app).toContain('.data_store_identifier(profile.main_store)');
    expect(app).toContain('.incognito(false)');
    expect(app.indexOf('tauri_plugin_macos_fps::init()'))
      .toBeLessThan(app.indexOf('tauri::WebviewWindowBuilder::from_config'));
    expect(app).toContain('.run(context)');
    expect(lib.indexOf('builder.data_store_identifier(profile.browser_store)'))
      .toBeLessThan(lib.indexOf('main.add_child('));
    expect(profile).toContain('major < 14');
    expect(profile).toContain('profile HOME and CFFIXED_USER_HOME before exec');
  });

  it('confirms absent provider resources so repeat navigation and close remain possible', async () => {
    const invoke = vi.fn();
    const ensure = vi.fn(() => Promise.reject(new Error('disabled')));
    const lifecycle = {
      liveGeneration: 3, controlGeneration: 0, confirmedAbsentControlGeneration: 0,
    };
    const remove = Function('state', 'invoke', 'ensureBrowserControlProvider', 'browserTabLifecycle',
      `return (${body('removeBrowserControlResource')});`)(
      { env: { acceptance_profile: true } }, invoke, ensure, () => lifecycle,
    );
    await expect(remove({ project: {}, tab: {} }, 3)).resolves.toBe(true);
    expect(lifecycle.confirmedAbsentControlGeneration).toBe(3);
    expect(ensure).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    lifecycle.controlGeneration = 4;
    await expect(remove({ project: {}, tab: {} }, 4)).resolves.toBe(false);
  });

  it('keeps production identity unchanged and fences provider IPC natively', () => {
    expect(JSON.parse(read('src-tauri/tauri.conf.json')).identifier).toBe('dev.opencoven.psyche');
    expect(JSON.parse(read('src-tauri/tauri.acceptance.conf.json')).identifier)
      .toBe('dev.opencoven.psyche.acceptance');
    expect(app).toContain('acceptance::command_allowed(invoke.message.command())');
    expect(profile).toContain('command.starts_with("control_")');
    expect(profile).toContain('command.starts_with("coven_")');
    expect(profile).toContain('std::env::remove_var(key)');
    expect(main).toContain('!state.env.acceptance_profile && activeTab');
  });
});
