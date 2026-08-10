import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const inputModule = await import(
  pathToFileURL(join(webRoot, 'input/terminal-drop.mjs')).href
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('terminal image drop helpers', () => {
  it('filters supported image paths in drop order and shell-quotes them', () => {
    expect(
      inputModule.buildImageDropInsertion([
        '/tmp/cover image.PNG',
        "/tmp/witch's portrait.jpg",
        '/tmp/notes.md',
        '/tmp/reference.AVIF',
      ])
    ).toEqual({
      accepted: [
        '/tmp/cover image.PNG',
        "/tmp/witch's portrait.jpg",
        '/tmp/reference.AVIF',
      ],
      skipped: ['/tmp/notes.md'],
      text:
        "'/tmp/cover image.PNG' '/tmp/witch'\\''s portrait.jpg' '/tmp/reference.AVIF'",
    });
  });

  it('supports the approved image extensions case-insensitively', () => {
    for (const extension of [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'avif',
      'heic',
      'heif',
      'tif',
      'tiff',
      'bmp',
      'svg',
    ]) {
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension}`)).toBe(true);
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension.toUpperCase()}`)).toBe(true);
    }

    expect(inputModule.isSupportedImagePath('/tmp/image.txt')).toBe(false);
    expect(inputModule.isSupportedImagePath('/tmp/image.png.txt')).toBe(false);
  });

  it('rejects control characters from otherwise supported image paths', () => {
    const safePaths = [
      '/tmp/雪 (final)! #1.png',
      '/tmp/portrait—draft.jpg',
    ];
    const unsafePaths = [
      '/tmp/new\nline.png',
      '/tmp/carriage\rreturn.jpg',
      '/tmp/interrupt\x03.png',
      '/tmp/escape\x1b.jpg',
      '/tmp/delete\x7f.png',
      '/tmp/c1\x85.jpg',
    ];

    for (const path of unsafePaths) {
      expect(inputModule.isSupportedImagePath(path)).toBe(false);
    }

    const insertion = inputModule.buildImageDropInsertion([
      safePaths[0],
      ...unsafePaths,
      safePaths[1],
    ]);

    expect(insertion.accepted).toEqual(safePaths);
    expect(insertion.skipped).toEqual(unsafePaths);
    expect(insertion.text).toBe(
      "'/tmp/雪 (final)! #1.png' '/tmp/portrait—draft.jpg'",
    );
    expect(insertion.accepted.join('')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(insertion.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it('converts Tauri physical coordinates to CSS coordinates', () => {
    expect(inputModule.physicalToCssPosition({ x: 300, y: 180 }, 2)).toEqual({
      x: 150,
      y: 90,
    });
    expect(inputModule.physicalToCssPosition({ x: 0, y: -20 }, 2)).toEqual({
      x: 0,
      y: -10,
    });
  });

  it('rejects invalid coordinates and scale factors', () => {
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, 0)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, -1)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, Number.NaN)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, Number.POSITIVE_INFINITY)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: Number.NaN, y: 2 }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: Number.POSITIVE_INFINITY, y: 2 }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: Number.POSITIVE_INFINITY }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: Number.NaN, y: Number.NaN }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition(null, 2)).toBeNull();
  });
});

describe('native terminal image drop targeting', () => {
  it('accepts only live running terminal threads', () => {
    const acceptsImageDrop = compileFunction<(thread: Record<string, unknown> | null) => boolean>(
      functionSource('acceptsImageDrop'),
      {},
    );
    const running = {
      kind: 'shell',
      closing: false,
      closeStarted: false,
      status: 'running',
      ptyStarted: true,
    };

    expect(acceptsImageDrop(running)).toBe(true);
    expect(acceptsImageDrop({ ...running, kind: 'coven' })).toBe(true);
    expect(acceptsImageDrop(null)).toBe(false);
    expect(acceptsImageDrop({ ...running, kind: 'web' })).toBe(false);
    expect(acceptsImageDrop({ ...running, status: 'starting', ptyStarted: false })).toBe(false);
    expect(acceptsImageDrop({ ...running, status: 'failed', ptyStarted: false })).toBe(false);
    expect(acceptsImageDrop({ ...running, status: 'exited', ptyStarted: false })).toBe(false);
    expect(acceptsImageDrop({ ...running, closing: true })).toBe(false);
    expect(acceptsImageDrop({ ...running, closeStarted: true })).toBe(false);
  });

  it('resolves physical coordinates to the nearest accepted terminal pane', () => {
    const thread = { id: 'thread-a', status: 'running', ptyStarted: true };
    const coordinateCalls: Array<[unknown, number]> = [];
    const pointCalls: Array<[number, number]> = [];
    const closestCalls: string[] = [];
    const findCalls: string[] = [];
    const resolveImageDropTarget = compileFunction<
      (position: { x: number; y: number }, scaleFactor: number) => typeof thread | null
    >(functionSource('resolveImageDropTarget'), {
      PsycheTerminalInput: {
        physicalToCssPosition(position: unknown, scaleFactor: number) {
          coordinateCalls.push([position, scaleFactor]);
          return { x: 150, y: 90 };
        },
      },
      document: {
        elementFromPoint(x: number, y: number) {
          pointCalls.push([x, y]);
          return {
            closest(selector: string) {
              closestCalls.push(selector);
              return { dataset: { threadId: 'thread-a' } };
            },
          };
        },
      },
      findThread(id: string) {
        findCalls.push(id);
        return thread;
      },
      acceptsImageDrop(value: typeof thread) {
        return value === thread;
      },
    });

    expect(resolveImageDropTarget({ x: 300, y: 180 }, 2)).toBe(thread);
    expect(coordinateCalls).toEqual([[{ x: 300, y: 180 }, 2]]);
    expect(pointCalls).toEqual([[150, 90]]);
    expect(closestCalls).toEqual(['.terminal-pane[data-thread-id]']);
    expect(findCalls).toEqual(['thread-a']);
  });

  it('returns no target for invalid coordinates, missing panes, or rejected threads', () => {
    const resolveWith = (cssPosition: unknown, pane: unknown, accepted: boolean) =>
      compileFunction<(position: unknown, scaleFactor: number) => unknown>(
        functionSource('resolveImageDropTarget'),
        {
          PsycheTerminalInput: { physicalToCssPosition: () => cssPosition },
          document: {
            elementFromPoint: () => pane
              ? { closest: () => pane }
              : null,
          },
          findThread: () => ({ id: 'thread-a' }),
          acceptsImageDrop: () => accepted,
        },
      )({}, 2);

    expect(resolveWith(null, null, true)).toBeNull();
    expect(resolveWith({ x: 1, y: 2 }, null, true)).toBeNull();
    expect(resolveWith({ x: 1, y: 2 }, { dataset: { threadId: 'thread-a' } }, false)).toBeNull();
  });

  it('sets and clears a single pane highlight', () => {
    const removed: string[] = [];
    const added: string[] = [];
    const pane = {
      classList: {
        add: (name: string) => added.push(name),
        remove: (name: string) => removed.push(name),
      },
    };
    const thread = { id: 'thread-a', pane };
    const controls = Function(
      'acceptsImageDrop',
      `"use strict";
       var imageDropTarget = null;
       var clearImageDropTarget = ${functionSource('clearImageDropTarget')};
       var setImageDropTarget = ${functionSource('setImageDropTarget')};
       return {
         set: setImageDropTarget,
         clear: clearImageDropTarget,
         target: function () { return imageDropTarget; }
       };`,
    )(() => true) as {
      set: (value: typeof thread | null) => unknown;
      clear: () => void;
      target: () => typeof thread | null;
    };

    controls.set(thread);
    controls.set(thread);
    expect(controls.target()).toBe(thread);
    expect(added).toEqual(['image-drop-target']);
    expect(removed).toEqual([]);

    controls.clear();
    expect(controls.target()).toBeNull();
    expect(removed).toEqual(['image-drop-target']);
  });
});

describe('native terminal image insertion', () => {
  const thread = {
    id: 'thread-a',
    kind: 'shell',
    status: 'running',
    ptyStarted: true,
  };

  it('focuses, revalidates, and writes only the quoted insertion text', async () => {
    const calls: string[] = [];
    const currentThread = { ...thread };
    const insertDroppedImages = compileFunction<
      (target: typeof thread, paths: string[]) => Promise<boolean>
    >(functionSource('insertDroppedImages'), {
      PsycheTerminalInput: {
        buildImageDropInsertion(paths: string[]) {
          calls.push(`build:${paths.join('|')}`);
          return {
            accepted: ['/images/one.png', '/images/two.jpg'],
            skipped: [],
            text: "'/images/one.png' '/images/two.jpg'",
          };
        },
      },
      focusThread: async (id: string) => {
        calls.push(`focus:${id}`);
        return true;
      },
      findThread: (id: string) => {
        calls.push(`find:${id}`);
        return currentThread;
      },
      acceptsImageDrop: (value: unknown) => value === currentThread,
      sendToThread: async (value: unknown, text: string) => {
        calls.push(`send:${value === currentThread}:${JSON.stringify(text)}`);
        return true;
      },
      setStatus: () => undefined,
      toast: () => undefined,
    });

    await expect(insertDroppedImages(thread, ['/images/one.png', '/images/two.jpg']))
      .resolves.toBe(true);
    expect(calls).toEqual([
      'build:/images/one.png|/images/two.jpg',
      'focus:thread-a',
      'find:thread-a',
      `send:true:${JSON.stringify("'/images/one.png' '/images/two.jpg'")}`,
    ]);
  });

  it('reports skipped paths with singular and plural grammar after writing', async () => {
    const messages: string[] = [];
    const insertionResults = [
      { accepted: ['/a.png'], skipped: ['/a.txt'], text: "'/a.png'" },
      {
        accepted: ['/a.png', '/b.jpg'],
        skipped: ['/a.txt', '/b.mov'],
        text: "'/a.png' '/b.jpg'",
      },
    ];
    const insertDroppedImages = compileFunction<
      (target: typeof thread, paths: string[]) => Promise<boolean>
    >(functionSource('insertDroppedImages'), {
      PsycheTerminalInput: { buildImageDropInsertion: () => insertionResults.shift() },
      focusThread: async () => true,
      findThread: () => thread,
      acceptsImageDrop: () => true,
      sendToThread: async () => true,
      setStatus: () => undefined,
      toast: (message: string) => messages.push(message),
    });

    await insertDroppedImages(thread, []);
    await insertDroppedImages(thread, []);
    expect(messages).toEqual([
      'Inserted 1 image; skipped 1 unsupported file',
      'Inserted 2 images; skipped 2 unsupported files',
    ]);
  });

  it('warns and sends nothing when the drop has no supported images', async () => {
    const messages: string[] = [];
    let focusCalls = 0;
    let sendCalls = 0;
    const insertDroppedImages = compileFunction<
      (target: typeof thread, paths: string[]) => Promise<boolean>
    >(functionSource('insertDroppedImages'), {
      PsycheTerminalInput: {
        buildImageDropInsertion: () => ({ accepted: [], skipped: ['/a.txt'], text: '' }),
      },
      focusThread: async () => { focusCalls += 1; return true; },
      findThread: () => thread,
      acceptsImageDrop: () => true,
      sendToThread: async () => { sendCalls += 1; return true; },
      setStatus: () => undefined,
      toast: (message: string) => messages.push(message),
    });

    await expect(insertDroppedImages(thread, ['/a.txt'])).resolves.toBe(false);
    expect(messages).toEqual(['No supported images in this drop']);
    expect(focusCalls).toBe(0);
    expect(sendCalls).toBe(0);
  });

  it.each([
    {
      name: 'focus failure',
      focusResult: false,
      found: thread,
      accepted: true,
      sendResult: true,
      expectedLevel: 'warn',
      expectedText: /focus/i,
    },
    {
      name: 'stale target',
      focusResult: true,
      found: null,
      accepted: false,
      sendResult: true,
      expectedLevel: 'warn',
      expectedText: /stale|no longer|unavailable/i,
    },
    {
      name: 'write failure',
      focusResult: true,
      found: thread,
      accepted: true,
      sendResult: false,
      expectedLevel: 'error',
      expectedText: /write/i,
    },
  ])('reports $name and returns false', async ({
    focusResult,
    found,
    accepted,
    sendResult,
    expectedLevel,
    expectedText,
  }) => {
    const statuses: Array<[string, string]> = [];
    const insertDroppedImages = compileFunction<
      (target: typeof thread, paths: string[]) => Promise<boolean>
    >(functionSource('insertDroppedImages'), {
      PsycheTerminalInput: {
        buildImageDropInsertion: () => ({
          accepted: ['/a.png'],
          skipped: [],
          text: "'/a.png'",
        }),
      },
      focusThread: async () => focusResult,
      findThread: () => found,
      acceptsImageDrop: () => accepted,
      sendToThread: async () => sendResult,
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      toast: () => undefined,
    });

    await expect(insertDroppedImages(thread, ['/a.png'])).resolves.toBe(false);
    expect(statuses).toHaveLength(1);
    expect(statuses[0][0]).toMatch(expectedText);
    expect(statuses[0][1]).toBe(expectedLevel);
  });
});

describe('native terminal image drop events', () => {
  it('highlights enter and over targets, and clears on leave', async () => {
    const thread = { id: 'thread-a' };
    const actions: string[] = [];
    const handleTerminalImageDropEvent = compileFunction<
      (event: { payload: Record<string, unknown> }) => Promise<boolean>
    >(functionSource('handleTerminalImageDropEvent'), {
      imageDropScaleFactor: 2,
      resolveImageDropTarget: (_position: unknown, scale: number) => {
        actions.push(`resolve:${scale}`);
        return thread;
      },
      setImageDropTarget: (value: unknown) => actions.push(`set:${value === thread}`),
      clearImageDropTarget: () => actions.push('clear'),
      insertDroppedImages: async () => true,
      toast: () => undefined,
    });

    await expect(handleTerminalImageDropEvent({
      payload: { type: 'enter', position: { x: 300, y: 180 } },
    })).resolves.toBe(true);
    await expect(handleTerminalImageDropEvent({
      payload: { type: 'over', position: { x: 320, y: 200 } },
    })).resolves.toBe(true);
    await expect(handleTerminalImageDropEvent({ payload: { type: 'leave' } }))
      .resolves.toBe(false);
    expect(actions).toEqual([
      'resolve:2', 'set:true',
      'resolve:2', 'set:true',
      'clear',
    ]);
  });

  it('clears before inserting a valid drop and preserves path order', async () => {
    const thread = { id: 'thread-a' };
    const actions: string[] = [];
    const paths = ['/images/b.jpg', '/images/a.png'];
    const handleTerminalImageDropEvent = compileFunction<
      (event: { payload: Record<string, unknown> }) => Promise<boolean>
    >(functionSource('handleTerminalImageDropEvent'), {
      imageDropScaleFactor: 2,
      resolveImageDropTarget: () => thread,
      setImageDropTarget: () => actions.push('set'),
      clearImageDropTarget: () => actions.push('clear'),
      insertDroppedImages: async (value: unknown, received: string[]) => {
        actions.push(`insert:${value === thread}:${received.join('|')}`);
        return true;
      },
      toast: () => undefined,
    });

    await expect(handleTerminalImageDropEvent({
      payload: { type: 'drop', position: { x: 300, y: 180 }, paths },
    })).resolves.toBe(true);
    expect(actions).toEqual([
      'set',
      'clear',
      'insert:true:/images/b.jpg|/images/a.png',
    ]);
  });

  it('warns and does not insert when a drop has no valid target', async () => {
    const actions: string[] = [];
    const handleTerminalImageDropEvent = compileFunction<
      (event: { payload: Record<string, unknown> }) => Promise<boolean>
    >(functionSource('handleTerminalImageDropEvent'), {
      imageDropScaleFactor: 1,
      resolveImageDropTarget: () => null,
      setImageDropTarget: () => actions.push('set'),
      clearImageDropTarget: () => actions.push('clear'),
      insertDroppedImages: async () => { actions.push('insert'); return true; },
      toast: (message: string) => actions.push(`toast:${message}`),
    });

    await expect(handleTerminalImageDropEvent({
      payload: { type: 'drop', position: { x: 1, y: 2 }, paths: ['/a.png'] },
    })).resolves.toBe(false);
    expect(actions).toEqual([
      'set',
      'clear',
      'toast:Drop images onto a running terminal pane',
    ]);
  });
});

describe('native terminal image drop wiring', () => {
  it('awaits scale and listener registration, tracks scale changes, and clears on blur', async () => {
    const actions: string[] = [];
    const listeners: {
      scale?: (event: { payload: { scaleFactor: number } }) => void;
      drag?: (event: { payload: Record<string, unknown> }) => Promise<boolean>;
      blur?: () => void;
    } = {};
    const controls = Function(
      'currentWindow',
      'window',
      'setStatus',
      'clearImageDropTarget',
      'handleTerminalImageDropEvent',
      `"use strict";
       var imageDropScaleFactor = 1;
       var installTerminalImageDrop = ${functionSource('installTerminalImageDrop')};
       return {
         install: installTerminalImageDrop,
         scale: function () { return imageDropScaleFactor; }
       };`,
    )(
      {
        async scaleFactor() {
          actions.push('scale');
          return 2;
        },
        async onScaleChanged(listener: typeof listeners.scale) {
          actions.push('scale-listener');
          listeners.scale = listener;
        },
        async onDragDropEvent(listener: typeof listeners.drag) {
          actions.push('drag-listener');
          listeners.drag = listener;
        },
      },
      {
        addEventListener(name: string, listener: () => void) {
          actions.push(`window:${name}`);
          if (name === 'blur') listeners.blur = listener;
        },
      },
      (text: string, level: string) => actions.push(`status:${level}:${text}`),
      () => actions.push('clear'),
      async () => true,
    ) as { install: () => Promise<boolean>; scale: () => number };

    await expect(controls.install()).resolves.toBe(true);
    expect(actions).toEqual(['scale', 'scale-listener', 'drag-listener', 'window:blur']);
    expect(listeners.drag).toBeDefined();
    expect(controls.scale()).toBe(2);

    listeners.scale?.({ payload: { scaleFactor: 3 } });
    expect(controls.scale()).toBe(3);
    expect(actions.at(-1)).toBe('clear');

    listeners.scale?.({ payload: { scaleFactor: Number.NaN } });
    expect(controls.scale()).toBe(3);
    listeners.blur?.();
    expect(actions.at(-1)).toBe('clear');
  });

  it('warns when the Tauri window API is missing or registration fails', async () => {
    const statuses: Array<[string, string]> = [];
    const installMissing = compileFunction<() => Promise<boolean>>(
      functionSource('installTerminalImageDrop'),
      {
        currentWindow: null,
        imageDropScaleFactor: 1,
        window: { addEventListener: () => undefined },
        setStatus: (text: string, level: string) => statuses.push([text, level]),
        clearImageDropTarget: () => undefined,
        handleTerminalImageDropEvent: () => undefined,
      },
    );

    await expect(installMissing()).resolves.toBe(false);
    expect(statuses).toEqual([
      ['image drop unavailable: Tauri window API missing', 'warn'],
    ]);

    const actions: string[] = [];
    const installFailing = compileFunction<() => Promise<boolean>>(
      functionSource('installTerminalImageDrop'),
      {
        currentWindow: {
          scaleFactor: async () => { throw new Error('scale exploded'); },
          onDragDropEvent: async () => undefined,
        },
        imageDropScaleFactor: 1,
        window: { addEventListener: () => undefined },
        setStatus: (text: string, level: string) => actions.push(`${level}:${text}`),
        clearImageDropTarget: () => actions.push('clear'),
        handleTerminalImageDropEvent: () => undefined,
      },
    );

    await expect(installFailing()).resolves.toBe(false);
    expect(actions).toEqual([
      'clear',
      'warn:image drop unavailable: Error: scale exploded',
    ]);
  });

  it.each([
    Number.NaN,
    0,
  ])('warns when the initial scale factor is invalid (%s)', async (scaleResult) => {
    const actions: string[] = [];
    const installInvalidScale = compileFunction<() => Promise<boolean>>(
      functionSource('installTerminalImageDrop'),
      {
        currentWindow: {
          scaleFactor: async () => scaleResult,
          onScaleChanged: async () => actions.push('scale-listener'),
          onDragDropEvent: async () => actions.push('drag-listener'),
        },
        imageDropScaleFactor: 1,
        window: { addEventListener: () => actions.push('blur-listener') },
        setStatus: (text: string, level: string) => actions.push(`${level}:${text}`),
        clearImageDropTarget: () => actions.push('clear'),
        handleTerminalImageDropEvent: () => undefined,
      },
    );

    await expect(installInvalidScale()).resolves.toBe(false);
    expect(actions).toEqual([
      'clear',
      'warn:image drop unavailable: Error: invalid window scale factor',
    ]);
  });

  it('installs image drop once at the start of boot', () => {
    expect(mainJs).toContain('var imageDropScaleFactor = 1;');
    expect(mainJs).toContain('var imageDropTarget = null;');
    expect(functionSource('boot')).toMatch(
      /state\.env = env \|\| \{\};\s*await installTerminalImageDrop\(\);/,
    );
    expect(functionSource('boot').match(/installTerminalImageDrop\(\)/g)).toHaveLength(1);
  });

  it('styles the pane target with the required visible instruction', () => {
    const targetRule = stylesCss.match(/\.terminal-pane\.image-drop-target\s*\{([^}]*)\}/s)?.[1];
    const overlayRule = stylesCss.match(/\.terminal-pane\.image-drop-target::after\s*\{([^}]*)\}/s)?.[1];

    expect(targetRule).toBeTruthy();
    expect(targetRule).toContain('border-color: rgba(var(--rgb-accent), 0.72);');
    expect(targetRule).toContain('box-shadow:');
    expect(overlayRule).toBeTruthy();
    expect(overlayRule).toContain('content: "Drop images to insert paths";');
    expect(overlayRule).toContain('left: 50%;');
    expect(overlayRule).toContain('top: 50%;');
    expect(overlayRule).toContain('transform: translate(-50%, -50%);');
    expect(overlayRule).toContain('padding: 8px 12px;');
    expect(overlayRule).toContain('border: 1px solid rgba(var(--rgb-accent), 0.26);');
    expect(overlayRule).toContain('border-radius: 999px;');
    expect(overlayRule).toContain('background: var(--surface-1);');
    expect(overlayRule).toContain('pointer-events: none;');
    expect(overlayRule).not.toContain('inset:');
    expect(overlayRule).not.toContain('display: grid;');
    expect(overlayRule).not.toContain('place-items: center;');
    expect(stylesCss).toMatch(/\.terminal-pane\s*\{[^}]*position:\s*relative/s);
  });
});

describe('terminal input bundle wiring', () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/package.json'), 'utf8')
  ) as { scripts: Record<string, string> };
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

  it('builds and loads PsycheTerminalInput before the application shell', () => {
    expect(packageJson.scripts['build:web']).toContain(
      'esbuild web/input/input-entry.js --bundle --minify --format=iife ' +
        '--global-name=PsycheTerminalInput --outfile=web/input.bundle.js'
    );
    const inputScript = '<script src="./input.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';
    expect(indexHtml).toContain(inputScript);
    expect(indexHtml.indexOf(inputScript)).toBeLessThan(indexHtml.indexOf(mainScript));
  });
});
