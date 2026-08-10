import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const mainJs = readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'), 'utf8');
const stylesCss = readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'), 'utf8');
const tauriLib = readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'), 'utf8');
const indexHtml = readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'), 'utf8');
const tauriConfig = JSON.parse(
  readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json'), 'utf8')
);

describe('Tauri desktop tab shortcuts', () => {
  it('routes Command+T based on the last focused desktop surface', () => {
    expect(mainJs).toMatch(/var\s+activeSurface\s*=\s*"terminal";/);
    expect(mainJs).toMatch(/function\s+createContextualTab\(\)/);
    expect(mainJs).toMatch(/markActiveSurface\(\s*"terminal"\s*\)/);
    expect(mainJs).toMatch(/markActiveSurface\(\s*"browser"\s*\)/);
    expect(mainJs).toMatch(
      /if\s*\(\s*activeSurface\s*===\s*"browser"\s*\)[\s\S]*openBlankBrowserTab\(\);[\s\S]*return\s*\(await spawnCovenThread\(\)\)\s*\?\s*true\s*:\s*null;/
    );
  });

  it('swaps the dirty dot for the close control in one non-reflowing slot', () => {
    // Both controls live in the same fixed-width slot, so revealing one cannot
    // shift the strip.
    expect(mainJs).toMatch(/<span class="tab-end">/);
    expect(stylesCss).toMatch(/\.tab-end \{[^}]*flex: 0 0 16px/);
    expect(stylesCss).toMatch(/\.tab \.dot \{[^}]*position: absolute/);
    expect(stylesCss).toMatch(/\.tab \.close \{[^}]*position: absolute/);
    expect(stylesCss).toContain('.tab:hover .close { opacity: 1; }');
    expect(stylesCss).toContain('.tab:hover .dot { opacity: 0; }');
    // The active tab keeps its dot: that is the file whose unsaved state matters.
    expect(stylesCss).not.toMatch(/\.tab\.active \.dot \{[^}]*opacity: 0/);
  });

  it('closes a file tab on middle click', () => {
    expect(mainJs).toMatch(
      /addEventListener\("auxclick",[\s\S]*e\.button !== 1[\s\S]*closeFileTab\(file\.id\)/
    );
  });

  it('fades the strip edges only while it actually overflows', () => {
    expect(mainJs).toMatch(
      /function syncTabStripOverflow\(\)[\s\S]*scrollWidth > tabStripEl\.clientWidth \+ 1[\s\S]*toggle\("is-overflowing"/
    );
    expect(mainJs).toMatch(/function scrollActiveTabIntoView\(\)[\s\S]*scrollIntoView/);
    // Refreshing the strip and resizing the window both re-measure.
    expect(mainJs).toMatch(/syncTabStripOverflow\(\);\n    scrollActiveTabIntoView\(\);/);
    expect(stylesCss).toMatch(/\.tab-strip\.is-overflowing \{[^}]*mask-image/);
    expect(stylesCss).not.toMatch(/\.tab-strip \{[^}]*[^.]mask-image/);
  });

  it('lets embedded browser webviews request a new browser tab with Command+T', () => {
    expect(tauriLib).toMatch(/browser:shortcut-new-tab/);
    expect(tauriLib).toMatch(/event\.key\.toLowerCase\(\)\s*===\s*"t"/);
    expect(tauriLib).toMatch(/function\(browserLabel\)/);
    expect(tauriLib).not.toMatch(/label_json,\s*label_json/);
    expect(mainJs).toMatch(/listen\(\s*"browser:shortcut-new-tab"/);
  });

  it('keeps browser navigation single-shot for newly created webviews', () => {
    expect(tauriLib).toMatch(/fn\s+ensure_browser[\s\S]*?->\s*Result<bool,\s*String>/);
    expect(tauriLib).toMatch(/return\s+Ok\(false\);/);
    expect(tauriLib).toMatch(/let\s+created\s*=\s*ensure_browser\(/);
    expect(tauriLib).toMatch(/if\s+!created\s*\{[\s\S]*?webview\s*=\s*app[\s\S]*?webview\s*\.set_position\(LogicalPosition::new\(x,\s*y\)\)[\s\S]*?webview\s*\.set_size\(LogicalSize::new\(w\.max\(1\.0\),\s*h\.max\(1\.0\)\)\)/);
    expect(tauriLib).toMatch(/if\s+!created\s*\{[\s\S]*?webview\.navigate\(parsed_url\)/);
  });

  it('reports PTY exit codes and avoids machine-specific nvm paths', () => {
    expect(tauriLib).toMatch(/status\.ok\(\)\.map\(\|s\|\s*s\.exit_code\(\)\s+as\s+i32\)/);
    expect(tauriLib).toMatch(/static\s+AUGMENTED_PATH:\s*Lazy<String>\s*=\s*Lazy::new\(compute_augmented_path\);/);
    expect(tauriLib).toMatch(/fn\s+augmented_path\(\)\s*->\s*&'static\s+str/);
    expect(tauriLib).toMatch(/fn\s+compute_augmented_path\(\)\s*->\s*String/);
    expect(tauriLib).toMatch(/let\s+mut\s+parts:\s*Vec<PathBuf>\s*=\s*Vec::new\(\);/);
    expect(tauriLib).toMatch(/for\s+p\s+in\s+std::env::split_paths\(&existing\)[\s\S]*?parts\.push\(p\);[\s\S]*?for\s+extra\s+in\s+extras/);
    expect(tauriLib).toMatch(/std::env::join_paths\(&parts\)/);
    expect(tauriLib).toMatch(/\.unwrap_or_else\(\|_\|\s+existing\.clone\(\)\)/);
    const augmentedPathFunction = tauriLib.match(
      /fn\s+compute_augmented_path\(\)\s*->\s*String\s*\{[\s\S]*?\n\}\n\nfn\s+push_path_if_dir/
    )?.[0];
    expect(augmentedPathFunction).toBeTruthy();
    expect(augmentedPathFunction).not.toMatch(
      /std::env::join_paths\(&parts\)[\s\S]*?\.unwrap_or_default\(\)/
    );
    expect(tauriLib).toMatch(/for\s+dir\s+in\s+std::env::split_paths\(augmented_path\(\)\)/);
    expect(tauriLib).toMatch(/fn\s+newest_nvm_node_bin\(/);
    expect(tauriLib).not.toMatch(/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin/);
  });

  it('keeps Tauri backend shared-state operations grouped correctly', () => {
    expect(tauriLib).toMatch(/static\s+STARTING_SESSIONS:/);
    expect(tauriLib).toMatch(/let\s+pending_start\s*=\s*PendingPtyStart::reserve\(&thread_id\)\?/);
    expect(tauriLib).toMatch(
      /guard\.insert\(\s*thread_id\.clone\(\),[\s\S]*?\);\s*\}\s*drop\(pending_start\);/
    );
    expect(tauriLib).toMatch(
      /let\s+data_thread\s*=\s*std::thread::spawn[\s\S]*?app_for_data\.emit\("pty:data",\s*payload\)/
    );
    expect(tauriLib).toMatch(
      /let\s+code\s*=\s*status\.ok\(\)\.map\(\|s\|\s*s\.exit_code\(\)\s+as\s+i32\);[\s\S]*?let\s+_\s*=\s*data_thread\.join\(\);[\s\S]*?app_for_exit\.emit\(\s*"pty:exit"/
    );
    expect(tauriLib).toMatch(
      /let\s+writer\s*=\s*\{[\s\S]*?let\s+guard\s*=\s*SESSIONS\.lock\(\);[\s\S]*?Arc::clone\(&session\.writer\)[\s\S]*?\};[\s\S]*?let\s+mut\s+writer\s*=\s*writer\.lock\(\);/
    );
    expect(tauriLib).toMatch(/fn\s+agent_skill_source_rank\(source:\s*&str\)\s*->\s*u8/);
    expect(tauriLib).toMatch(/"project"\s*=>\s*0,[\s\S]*?"user"\s*=>\s*1,[\s\S]*?"plugin"\s*=>\s*2/);
    expect(tauriLib).toMatch(
      /out\.sort_by\(\|a,\s*b\|\s*\{[\s\S]*?a\.name[\s\S]*?\.cmp\(&b\.name\)[\s\S]*?\.then\(a\.kind\.cmp\(&b\.kind\)\)[\s\S]*?agent_skill_source_rank\(&a\.source\)\.cmp\(&agent_skill_source_rank\(&b\.source\)\)[\s\S]*?\.then\(a\.source\.cmp\(&b\.source\)\)/
    );
    expect(tauriLib).toMatch(/out\.dedup_by\(\|a,\s*b\|\s*a\.name\s*==\s*b\.name\s*&&\s*a\.kind\s*==\s*b\.kind\)/);
    expect(tauriLib).not.toMatch(/let\s+_\s*=\s*app\.get_webview_window\("main"\);/);
  });

  it('keeps the Tauri app CSP free of broad unsafe allowances', () => {
    const csp = tauriConfig.app.security.csp as string;
    expect(csp).toMatch(/style-src\s+'self'/);
    expect(csp).toMatch(/script-src\s+'self'/);
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    expect(indexHtml).not.toMatch(/\sstyle=/);
    expect(mainJs).not.toMatch(/style\.cssText/);
  });

  it('keeps browser tabs thin and collapsible under narrow browser panes', () => {
    expect(stylesCss).toMatch(/--browser-tab-h:\s*22px;/);
    expect(stylesCss).toMatch(/grid-template-rows:\s*var\(--browser-bar-h\) var\(--browser-tab-h\) 1fr;/);
    expect(stylesCss).toMatch(/\.browser-tab\s*\{[\s\S]*?min-width:\s*34px;[\s\S]*?flex:\s*1 1 118px;/);
    expect(stylesCss).toMatch(/\.browser-tab-title\s*\{[\s\S]*?min-width:\s*0;/);
  });

  it('keeps terminal tabs horizontally scrollable without vertical overflow', () => {
    expect(stylesCss).toMatch(
      /\.tab-strip\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/
    );
  });
});
