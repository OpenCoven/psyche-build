(async function browserScriptRuntime(input) {
"use strict";
const $Function = Function;
const $Object = Object;
const $Array = Array;
const $Number = Number;
const $String = String;
const $JSON = JSON;
const $Reflect = Reflect;
const $Set = Set;
const $TextEncoder = TextEncoder;
const $performance = performance;
const $apply = $Reflect.apply;
const $ownKeys = $Reflect.ownKeys;
const $getPrototypeOf = $Object.getPrototypeOf;
const $getOwnPropertyDescriptor = $Object.getOwnPropertyDescriptor;
const $freeze = $Object.freeze;
const $arrayIsArray = $Array.isArray;
const $numberIsFinite = $Number.isFinite;
const $jsonStringify = $JSON.stringify;
const $setHas = $Set.prototype.has;
const $setAdd = $Set.prototype.add;
const $setDelete = $Set.prototype.delete;
const $textEncode = $TextEncoder.prototype.encode;
const $now = $performance.now;
const $objectPrototype = $Object.prototype;
const $arrayPrototype = $Array.prototype;
const $setPrototype = $Set.prototype;
const $textEncoderPrototype = $TextEncoder.prototype;
const $seen = new $Set();
const $encoder = new $TextEncoder();
const $started = $apply($now, $performance, []);

// This realm exists for one approved invocation. Freeze the serialization
// prototypes before approved source runs so it cannot alter the captured
// behavior during the same call.
$apply($freeze, $Object, [$objectPrototype]);
$apply($freeze, $Object, [$arrayPrototype]);
$apply($freeze, $Object, [$setPrototype]);
$apply($freeze, $Object, [$textEncoderPrototype]);

const $stringify = (value) => $apply($jsonStringify, $JSON, [value]);
const $fail = (code) => $stringify({ ok: false, code });
const $canonical = (value, depth = 0) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return $apply($numberIsFinite, $Number, [value]);
  if (typeof value !== "object" || depth >= 64 || $apply($setHas, $seen, [value])) return false;
  const array = $apply($arrayIsArray, $Array, [value]);
  if ($apply($getPrototypeOf, $Object, [value]) !== (array ? $arrayPrototype : $objectPrototype)) return false;
  $apply($setAdd, $seen, [value]);
  const keys = $apply($ownKeys, $Reflect, [value]);
  if (array) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = $apply($getOwnPropertyDescriptor, $Object, [value, $String(index)]);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !$canonical(descriptor.value, depth + 1)) return false;
    }
  } else {
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = $apply($getOwnPropertyDescriptor, $Object, [value, key]);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !$canonical(descriptor.value, depth + 1)) return false;
    }
  }
  $apply($setDelete, $seen, [value]);
  return true;
};

try {
  const execute = $Function("args", "\"use strict\";return (async()=>{" + input.source + "\n})()");
  const value = await execute(input.args);
  if (!$canonical(value)) return $fail("serialization_failed");
  const json = $stringify(value);
  if (typeof json !== "string") return $fail("serialization_failed");
  const byteCount = $apply($textEncode, $encoder, [json]).byteLength;
  if (byteCount > 262144) return $fail("result_too_large");
  const elapsed = $apply($now, $performance, []) - $started;
  const durationMs = elapsed >= 0 && $apply($numberIsFinite, $Number, [elapsed]) ? elapsed : 0;
  return $stringify({ ok: true, json, byteCount, durationMs });
} catch (_) {
  return $fail("automation_failed");
}
})
