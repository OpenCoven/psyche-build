# Vim Slice 2: Browser and Web Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the v1 Vim contract to the Vue browser terminal and dashboard while preserving `/api/keys` and native editable controls.

**Architecture:** A Vue composable wraps the shared machine and exposes semantic actions to existing terminal/dashboard methods. Passthrough continues through the existing key API; only explicit chrome mode consumes navigation input.

**Tech Stack:** Vue 3, TypeScript, Vitest, Vite, Playwright

**Tracking:** Claim `psyche-no8.2` after `psyche-no8.1` closes.

---

### Task 1: Add persistent web settings and the adapter

**Files:** Create `frontend/src/composables/useVimMode.ts`, `frontend/src/components/VimModeIndicator.vue`, `__tests__/webVimMode.test.ts`; modify `frontend/src/components/{Terminal,Dashboard}.vue`, `frontend/src/styles.css`, and frontend package dependencies.

- [ ] Write RED tests proving default disabled, clamped persisted settings, F6 entry, Escape restoration, native input/textarea/IME precedence, and reset on unmount/focus loss.
- [ ] Implement this interface using `@opencoven/psyche-vim-core`:

```ts
export interface WebVimMode {
  enabled: Readonly<Ref<boolean>>;
  context: Readonly<Ref<VimContext>>;
  pending: Readonly<Ref<string>>;
  handle(event: KeyboardEvent, target: WebVimTarget): boolean;
  reset(reason: 'focus-loss' | 'modal' | 'disabled' | 'dispose'): void;
}
```

- [ ] Store and sanitize all five v1 settings (`vimModeEnabled`, `vimChromeTrigger`, `vimSequenceTimeoutMs`, `vimRelativeLineNumbers`, `vimClipboard`) under existing web settings ownership, including unused-but-portable editor preferences; do not share desktop localStorage implicitly. Run `pnpm vitest --run __tests__/webVimMode.test.ts` GREEN.
- [ ] Commit: `Add shared Vim mode adapter to web`.

### Task 2: Route terminal and dashboard semantic actions

- [ ] Extend RED tests so printable/control/function/paste events reach `/api/keys` unchanged outside chrome mode; chrome keys never call it. Cover pane focus/cycle, collection movement, scoped search, guarded close, refresh, and help.
- [ ] Replace direct global-key logic with `vim.handle` before the existing transport. Map actions onto current `focusPane`, creation, dialog, refresh, and close functions; unsupported actions show status and do not fall through.
- [ ] Render `VimModeIndicator` with `role="status"`, concise labels, reduced-motion behavior, and an accessible opt-in setting/help table.
- [ ] Run `pnpm vitest --run __tests__/webVimMode.test.ts`, `pnpm --filter psyche-build-frontend build`, root `pnpm typecheck`, and Playwright keyboard/IME/accessibility smoke.
- [ ] Obtain spec then quality review; close `psyche-no8.2` with evidence. Commit: `Add Vim chrome navigation to web`.
