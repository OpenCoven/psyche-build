import { Buffer } from 'node:buffer';

const TrustedWeakSet = WeakSet;
const arrayIsArray = Array.isArray.bind(Array);
const numberIsFinite = Number.isFinite.bind(Number);
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const objectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const jsonStringify = JSON.stringify.bind(JSON);
const jsonParse = JSON.parse.bind(JSON);
const byteLength = Buffer.byteLength.bind(Buffer);

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

export interface BoundedJsonOptions {
  readonly maxBytes: number;
  readonly invalidCode: string;
  readonly sizeCode: string;
  readonly label: string;
}

export function canonicalizeBoundedJson(
  value: unknown,
  options: BoundedJsonOptions,
): { value: unknown; bytes: number } {
  const seen = new TrustedWeakSet<object>();
  let nodes = 0;

  const fail = (code: string, detail: string): never => {
    throw Object.assign(new Error(`${options.label} ${detail}`), { code });
  };
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail(options.invalidCode, 'is too deeply nested');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!numberIsFinite(item)) fail(options.invalidCode, 'contains a non-finite number');
      return;
    }
    if (typeof item !== 'object') fail(options.invalidCode, 'is not plain JSON data');
    const objectItem = item as object;
    if (seen.has(objectItem)) fail(options.invalidCode, 'contains a cycle');
    seen.add(objectItem);
    const keys = reflectOwnKeys(objectItem);
    if (arrayIsArray(objectItem)) {
      const arrayItem = objectItem as unknown[];
      if (objectGetPrototypeOf(arrayItem) !== Array.prototype) fail(options.invalidCode, 'contains a non-plain array');
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= arrayItem.length) {
          fail(options.invalidCode, 'contains an invalid array property');
        }
      }
      for (let index = 0; index < arrayItem.length; index += 1) {
        const descriptor = objectGetOwnPropertyDescriptor(arrayItem, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          fail(options.invalidCode, 'contains a sparse or accessor array entry');
        }
        visit((descriptor as PropertyDescriptor).value, depth + 1);
      }
    } else {
      const prototype = objectGetPrototypeOf(objectItem);
      if (prototype !== objectPrototype && prototype !== null) fail(options.invalidCode, 'contains a native object');
      for (const key of keys) {
        if (typeof key !== 'string') fail(options.invalidCode, 'contains a symbol property');
        const descriptor = objectGetOwnPropertyDescriptor(objectItem, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          fail(options.invalidCode, 'contains an accessor or hidden property');
        }
        visit((descriptor as PropertyDescriptor).value, depth + 1);
      }
    }
    seen.delete(objectItem);
  };

  visit(value, 0);
  const encoded = (() => {
    try {
      const result = jsonStringify(value);
      return result === undefined ? fail(options.invalidCode, 'is not JSON data') : result;
    } catch {
      return fail(options.invalidCode, 'cannot be encoded');
    }
  })();
  const bytes = byteLength(encoded, 'utf8');
  if (bytes > options.maxBytes) fail(options.sizeCode, 'exceeds the maximum size');
  try {
    return { value: jsonParse(encoded), bytes };
  } catch {
    return fail(options.invalidCode, 'cannot be decoded');
  }
}
