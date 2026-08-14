(function installBrowserScriptWorkerRuntime() {
  "use strict";

  const $global = globalThis;
  const $postMessage = $global.postMessage.bind($global);
  const $Function = Function;
  const $Object = Object;
  const $Array = Array;
  const $Number = Number;
  const $String = String;
  const $JSON = JSON;
  const $Reflect = Reflect;
  const $Set = Set;
  const $Map = Map;
  const $TextEncoder = TextEncoder;
  const $apply = $Reflect.apply;
  const $ownKeys = $Reflect.ownKeys;
  const $getPrototypeOf = $Object.getPrototypeOf;
  const $getOwnPropertyDescriptor = $Object.getOwnPropertyDescriptor;
  const $defineProperty = $Object.defineProperty;
  const $freeze = $Object.freeze;
  const $arrayIsArray = $Array.isArray;
  const $numberIsFinite = $Number.isFinite;
  const $jsonParse = $JSON.parse;
  const $jsonStringify = $JSON.stringify;
  const $setHas = $Set.prototype.has;
  const $setAdd = $Set.prototype.add;
  const $setDelete = $Set.prototype.delete;
  const $mapGet = $Map.prototype.get;
  const $mapSet = $Map.prototype.set;
  const $arrayPush = $Array.prototype.push;
  const $textEncode = $TextEncoder.prototype.encode;
  const $objectPrototype = $Object.prototype;
  const $arrayPrototype = $Array.prototype;
  const $setPrototype = $Set.prototype;
  const $mapPrototype = $Map.prototype;
  const $textEncoderPrototype = $TextEncoder.prototype;
  const $encoder = new $TextEncoder();
  const $typedArrayPrototype = $apply(
    $getPrototypeOf,
    $Object,
    [$apply(
      $getPrototypeOf,
      $Object,
      [$apply($textEncode, $encoder, [""])],
    )],
  );
  const $typedArrayByteLength = $apply(
    $getOwnPropertyDescriptor,
    $Object,
    [$typedArrayPrototype, "byteLength"],
  ).get;
  const $mutationPlanInvalid = {};
  const MAX_DEPTH = 64;
  const MAX_MUTATIONS = 256;
  const MAX_RESULT_BYTES = 262144;
  const blocked = [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
    "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
    "postMessage", "close", "addEventListener", "removeEventListener",
    "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "indexedDB", "caches",
  ];

  $apply($freeze, $Object, [$objectPrototype]);
  $apply($freeze, $Object, [$arrayPrototype]);
  $apply($freeze, $Object, [$setPrototype]);
  $apply($freeze, $Object, [$mapPrototype]);
  $apply($freeze, $Object, [$textEncoderPrototype]);

  for (let index = 0; index < blocked.length; index += 1) {
    const name = blocked[index];
    try {
      $apply($defineProperty, $Object, [$global, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      }]);
    } catch (_) {
      try {
        $global[name] = undefined;
      } catch (_) {}
    }
  }

  const canonical = (value, seen, depth) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return true;
    }
    if (typeof value === "number") {
      return $apply($numberIsFinite, $Number, [value]);
    }
    if (typeof value !== "object" || depth >= MAX_DEPTH ||
        $apply($setHas, seen, [value])) {
      return false;
    }

    const array = $apply($arrayIsArray, $Array, [value]);
    if ($apply($getPrototypeOf, $Object, [value]) !==
        (array ? $arrayPrototype : $objectPrototype)) {
      return false;
    }

    $apply($setAdd, seen, [value]);
    const keys = $apply($ownKeys, $Reflect, [value]);
    if (array) {
      if (keys.length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = $apply(
          $getOwnPropertyDescriptor,
          $Object,
          [value, $String(index)],
        );
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
            !canonical(descriptor.value, seen, depth + 1)) {
          return false;
        }
      }
      const lengthDescriptor = $apply(
        $getOwnPropertyDescriptor,
        $Object,
        [value, "length"],
      );
      if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
    } else {
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (typeof key !== "string") return false;
        const descriptor = $apply(
          $getOwnPropertyDescriptor,
          $Object,
          [value, key],
        );
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
            !canonical(descriptor.value, seen, depth + 1)) {
          return false;
        }
      }
    }
    $apply($setDelete, seen, [value]);
    return true;
  };

  const isCanonical = (value) => canonical(value, new $Set(), 0);
  const clone = (value) => $apply(
    $jsonParse,
    $JSON,
    [$apply($jsonStringify, $JSON, [value])],
  );
  const deepFreeze = (value) => {
    if (value === null || typeof value !== "object") return value;
    const keys = $apply($ownKeys, $Reflect, [value]);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = $apply(
        $getOwnPropertyDescriptor,
        $Object,
        [value, keys[index]],
      );
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
    return $apply($freeze, $Object, [value]);
  };
  const mutation = (plan, kind, nodeId, fields) => {
    if (plan.mutations.length >= MAX_MUTATIONS || typeof nodeId !== "string") {
      plan.invalid = true;
      throw $mutationPlanInvalid;
    }
    const record = { kind, nodeId };
    if (fields) {
      const keys = $apply($ownKeys, $Reflect, [fields]);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        record[key] = fields[key];
      }
    }
    $apply($freeze, $Object, [record]);
    $apply($arrayPush, plan.mutations, [record]);
  };
  const pageApi = (snapshot, plan) => {
    const immutableSnapshot = deepFreeze(clone(snapshot));
    const nodes = new $Map();
    for (let index = 0; index < immutableSnapshot.nodes.length; index += 1) {
      const node = immutableSnapshot.nodes[index];
      $apply($mapSet, nodes, [node.id, node]);
    }
    return $apply($freeze, $Object, [{
      snapshot: immutableSnapshot,
      get(nodeId) {
        return $apply($mapGet, nodes, [nodeId]) || null;
      },
      setText(nodeId, value) {
        mutation(plan, "set_text", nodeId, { value: $String(value) });
      },
      setAttribute(nodeId, name, value) {
        mutation(plan, "set_attribute", nodeId, {
          name: $String(name),
          value: $String(value),
        });
      },
      removeAttribute(nodeId, name) {
        mutation(plan, "remove_attribute", nodeId, {
          name: $String(name),
        });
      },
      setProperty(nodeId, name, value) {
        mutation(plan, "set_property", nodeId, {
          name: $String(name),
          value,
        });
      },
      setFormValue(nodeId, value) {
        mutation(plan, "set_form_value", nodeId, {
          value: $String(value),
        });
      },
      setChecked(nodeId, value) {
        mutation(plan, "set_checked", nodeId, { value: value === true });
      },
      focus(nodeId) {
        mutation(plan, "focus", nodeId);
      },
    }]);
  };

  let started = false;
  let sent = false;
  const finish = (envelope) => {
    if (sent) return;
    sent = true;
    $postMessage(envelope);
  };

  $global.onmessage = async function onBrowserScriptMessage(event) {
    if (started) return;
    started = true;
    try {
      $apply($defineProperty, $Object, [$global, "onmessage", {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      }]);
    } catch (_) {
      try {
        $global.onmessage = undefined;
      } catch (_) {}
    }

    const plan = { invalid: false, mutations: [] };
    try {
      const input = event && event.data ? event.data : {};
      const args = input.args === undefined ? null : input.args;
      const snapshot = input.snapshot === undefined ? { nodes: [] } : input.snapshot;
      if (!isCanonical(args) || !isCanonical(snapshot)) {
        finish({ ok: false, code: "serialization_failed" });
        return;
      }
      const page = pageApi(snapshot, plan);
      const execute = $Function(
        "args",
        "page",
        "\"use strict\";return (async()=>{" + $String(input.source || "") + "\n})()",
      );
      const value = await execute(clone(args), page);
      if (plan.invalid) {
        finish({ ok: false, code: "mutation_plan_invalid" });
        return;
      }
      if (!isCanonical(value) || !isCanonical(plan.mutations)) {
        finish({ ok: false, code: "serialization_failed" });
        return;
      }
      const envelope = {
        ok: true,
        value: clone(value),
        mutations: clone(plan.mutations),
      };
      const encoded = $apply($jsonStringify, $JSON, [envelope]);
      if (typeof encoded !== "string" ||
          $apply(
            $typedArrayByteLength,
            $apply($textEncode, $encoder, [encoded]),
            [],
          ) > MAX_RESULT_BYTES) {
        finish({ ok: false, code: "result_too_large" });
        return;
      }
      finish(envelope);
    } catch (error) {
      finish({
        ok: false,
        code: error === $mutationPlanInvalid || plan.invalid
          ? "mutation_plan_invalid"
          : "automation_failed",
      });
    }
  };
})();
