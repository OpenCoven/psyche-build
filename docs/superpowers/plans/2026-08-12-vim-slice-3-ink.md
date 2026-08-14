# Vim Slice 3: Ink TUI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in F6 chrome navigation to the Ink TUI without changing existing shortcuts while disabled.

**Architecture:** A focused hook adapts Ink input into the shared machine before the current shortcut chain. Semantic actions call existing pane/project/popup/lifecycle functions, and the footer/status surfaces expose mode and pending prefixes.

**Tech Stack:** TypeScript, React, Ink, ink-testing-library, Vitest

**Tracking:** Claim `psyche-no8.3` after `psyche-no8.2` closes.

---

### Task 1: Persist settings and install the precedence adapter

**Files:** Create `src/hooks/useVimChromeMode.ts`, `__tests__/useInputHandling.vimMode.test.tsx`; modify `src/types.ts`, `src/utils/settingsManager.ts`, `src/hooks/useInputHandling.ts`, `src/PsycheApp.tsx`.

- [ ] Write RED tests using the existing input harness for disabled-equivalence, `F6`, Escape, pending timeout, popup precedence, inline rename/native editing, and disable reset.
- [ ] Add all five approved typed settings and sanitizer defaults/clamps to `PsycheSettings`/`SettingsManager`; retain the editor-only preferences even where the Ink adapter does not consume them.
- [ ] Implement:

```ts
export function useVimChromeMode(options: {
  settings: Pick<PsycheSettings, 'vimModeEnabled' | 'vimChromeTrigger' | 'vimSequenceTimeoutMs'>;
  execute(action: VimAction): Promise<'handled' | 'unsupported'>;
  announce(message: string): void;
}): { route(input: string, key: Key): Promise<boolean>; context: VimContext; pending: string };
```

- [ ] Call `route` after active popup/editor precedence but before ordinary app shortcuts. If it returns false, run the existing chain byte-for-byte unchanged. Run focused tests GREEN.
- [ ] Commit: `Add opt-in Vim input precedence to Ink`.

### Task 2: Execute chrome actions and expose help/status

- [ ] Add RED behavior cases for spatial/list movement, first/last/page, scoped search, pane actions, guarded close, refresh, unsupported status, focus fallback, and `?` help.
- [ ] Map actions to existing `executePaneShortcut`, selection setters, project handlers, popup manager, and close guards. Do not create shell commands or duplicate lifecycle logic.
- [ ] Add `VIM CHROME <pending>` to `FooterHelp`/status only while active, plus an opt-in settings definition and mode-aware shortcuts popup section.
- [ ] Run focused Vim tests, all `useInputHandling`/settings/shortcuts tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
- [ ] Obtain independent reviews; close `psyche-no8.3`. Commit: `Add Vim chrome navigation to Ink`.
