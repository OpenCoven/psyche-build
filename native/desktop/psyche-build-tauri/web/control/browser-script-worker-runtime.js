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
  const $arrayPop = $Array.prototype.pop;
  const $textEncode = $TextEncoder.prototype.encode;
  const $objectPrototype = $Object.prototype;
  const $arrayPrototype = $Array.prototype;
  const $functionPrototype = $Function.prototype;
  const $asyncFunctionPrototype = $apply(
    $getPrototypeOf,
    $Object,
    [async function () {}],
  );
  const $generatorFunctionPrototype = $apply(
    $getPrototypeOf,
    $Object,
    [function* () {}],
  );
  const $asyncGeneratorFunctionPrototype = $apply(
    $getPrototypeOf,
    $Object,
    [async function* () {}],
  );
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
    "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "WebTransport", "EventSource",
    "FontFace", "FontFaceSet", "fonts",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
    "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
    "postMessage", "close", "addEventListener", "removeEventListener",
    "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "RTCPeerConnection", "MessageChannel", "MessagePort", "scheduler",
    "indexedDB", "caches", "cookieStore", "navigator", "location",
    "Notification", "reportError",
  ];
  const shadowed = ["eval", "Function"];
  for (let index = 0; index < blocked.length; index += 1) {
    $apply($arrayPush, shadowed, [blocked[index]]);
  }

  let authorityScrubbed = true;
  const replaceWithUndefined = (target, name, defineMissing) => {
    const descriptor = $apply(
      $getOwnPropertyDescriptor,
      $Object,
      [target, name],
    );
    if (!descriptor && !defineMissing) return;
    try {
      if (!descriptor || descriptor.configurable ||
          ("value" in descriptor && descriptor.writable)) {
        $apply($defineProperty, $Object, [target, name, {
          value: undefined,
          writable: false,
          enumerable: descriptor ? descriptor.enumerable : false,
          configurable: false,
        }]);
      }
    } catch (_) {
      authorityScrubbed = false;
    }
    const replacement = $apply(
      $getOwnPropertyDescriptor,
      $Object,
      [target, name],
    );
    if (!replacement || !("value" in replacement) ||
        replacement.value !== undefined || replacement.writable ||
        replacement.configurable) {
      authorityScrubbed = false;
    }
  };

  for (let index = 0; index < shadowed.length; index += 1) {
    const name = shadowed[index];
    let target = $global;
    while (target !== null) {
      replaceWithUndefined(target, name, target === $global);
      target = $apply($getPrototypeOf, $Object, [target]);
    }
  }

  const codeGenerationPrototypes = [
    $functionPrototype,
    $asyncFunctionPrototype,
    $generatorFunctionPrototype,
    $asyncGeneratorFunctionPrototype,
  ];
  for (let index = 0; index < codeGenerationPrototypes.length; index += 1) {
    const prototype = codeGenerationPrototypes[index];
    try {
      $apply($defineProperty, $Object, [prototype, "constructor", {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      }]);
    } catch (_) {
      authorityScrubbed = false;
    }
    const descriptor = $apply(
      $getOwnPropertyDescriptor,
      $Object,
      [prototype, "constructor"],
    );
    if (!descriptor || !("value" in descriptor) ||
        descriptor.value !== undefined || descriptor.writable ||
        descriptor.configurable) {
      authorityScrubbed = false;
    }
  }

  $apply($freeze, $Object, [$objectPrototype]);
  $apply($freeze, $Object, [$arrayPrototype]);
  $apply($freeze, $Object, [$setPrototype]);
  $apply($freeze, $Object, [$mapPrototype]);
  $apply($freeze, $Object, [$textEncoderPrototype]);

  const isWhitespace = (code) =>
    code === 9 || code === 10 || code === 11 || code === 12 ||
    code === 13 || code === 32 || code === 160 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
  const isIdentifierStart = (code) =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 36 || code === 95;
  const isIdentifierPart = (code) =>
    isIdentifierStart(code) || (code >= 48 && code <= 57);
  const sourceIsUnsafe = (value) => {
    const source = $String(value);
    const length = source.length;
    const skipSpaceAndComments = (start) => {
      let index = start;
      while (index < length) {
        const code = source.charCodeAt(index);
        if (isWhitespace(code)) {
          index += 1;
          continue;
        }
        if (source[index] === "/" && source[index + 1] === "/") {
          index += 2;
          while (index < length && source[index] !== "\n" &&
                 source[index] !== "\r" && source[index] !== "\u2028" &&
                 source[index] !== "\u2029") {
            index += 1;
          }
          continue;
        }
        if (source[index] === "/" && source[index + 1] === "*") {
          const end = source.indexOf("*/", index + 2);
          if (end < 0) return -1;
          index = end + 2;
          continue;
        }
        break;
      }
      return index;
    };
    const skipQuoted = (start, quote) => {
      let index = start + 1;
      while (index < length) {
        const character = source[index];
        if (character === "\\") {
          index += 2;
        } else if (character === quote) {
          return index + 1;
        } else if (character === "\n" || character === "\r" ||
                   character === "\u2028" || character === "\u2029") {
          return -1;
        } else {
          index += 1;
        }
      }
      return -1;
    };
    const scanTemplate = (start, depth) => {
      if (depth >= MAX_DEPTH) return { rejected: true, index: length };
      let index = start + 1;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === "`") {
          return { rejected: false, index: index + 1 };
        } else if (source[index] === "$" && source[index + 1] === "{") {
          const expression = scanCode(index + 2, true, depth + 1);
          if (expression.rejected) return expression;
          index = expression.index;
        } else {
          index += 1;
        }
      }
      return { rejected: true, index: length };
    };
    const scanCode = (start, templateExpression, depth) => {
      let index = start;
      let braces = 0;
      let canStartRegex = true;
      let pendingControl = false;
      let previousToken = "";
      const controlParentheses = new $Array();
      while (index < length) {
        const code = source.charCodeAt(index);
        const character = source[index];
        if (isWhitespace(code)) {
          index += 1;
          continue;
        }
        if (character === "/" && source[index + 1] === "/") {
          const next = skipSpaceAndComments(index);
          if (next < 0) return { rejected: true, index: length };
          index = next;
          continue;
        }
        if (character === "/" && source[index + 1] === "*") {
          const next = skipSpaceAndComments(index);
          if (next < 0) return { rejected: true, index: length };
          index = next;
          continue;
        }
        if (character === "'" || character === "\"") {
          index = skipQuoted(index, character);
          if (index < 0) return { rejected: true, index: length };
          canStartRegex = false;
          previousToken = "literal";
          continue;
        }
        if (character === "`") {
          const template = scanTemplate(index, depth);
          if (template.rejected) return template;
          index = template.index;
          canStartRegex = false;
          previousToken = "literal";
          continue;
        }
        if (character === "/") {
          if (canStartRegex) {
            return { rejected: true, index: length };
          } else {
            index += source[index + 1] === "=" ? 2 : 1;
            canStartRegex = true;
            previousToken = "operator";
          }
          continue;
        }
        if (code > 127 || character === "\\") {
          return { rejected: true, index: length };
        }
        if (isIdentifierStart(code)) {
          const identifierStart = index;
          index += 1;
          while (index < length &&
                 isIdentifierPart(source.charCodeAt(index))) {
            index += 1;
          }
          const identifier = source.slice(identifierStart, index);
          if (identifier === "import" && previousToken !== ".") {
            const next = skipSpaceAndComments(index);
            if (next < 0 || source[next] === "(") {
              return { rejected: true, index: length };
            }
          }
          pendingControl = identifier === "if" || identifier === "while" ||
            identifier === "for" || identifier === "with" ||
            identifier === "switch" || identifier === "catch";
          canStartRegex = identifier === "return" || identifier === "throw" ||
            identifier === "case" || identifier === "delete" ||
            identifier === "void" || identifier === "typeof" ||
            identifier === "new" || identifier === "in" ||
            identifier === "of" || identifier === "yield" ||
            identifier === "await" || identifier === "else" ||
            identifier === "do" || identifier === "instanceof";
          previousToken = identifier;
          continue;
        }
        if (code >= 48 && code <= 57) {
          index += 1;
          while (index < length) {
            const numberCode = source.charCodeAt(index);
            if (!isIdentifierPart(numberCode) && source[index] !== ".") break;
            index += 1;
          }
          canStartRegex = false;
          previousToken = "literal";
          continue;
        }
        if (character === "(") {
          $apply($arrayPush, controlParentheses, [pendingControl]);
          pendingControl = false;
          canStartRegex = true;
          previousToken = "(";
          index += 1;
          continue;
        }
        if (character === ")") {
          canStartRegex = $apply($arrayPop, controlParentheses, []) === true;
          previousToken = ")";
          index += 1;
          continue;
        }
        if (character === "{") {
          braces += 1;
          pendingControl = false;
          canStartRegex = true;
          previousToken = "{";
          index += 1;
          continue;
        }
        if (character === "}") {
          if (templateExpression && braces === 0) {
            return { rejected: false, index: index + 1 };
          }
          if (braces === 0) return { rejected: true, index: length };
          braces -= 1;
          canStartRegex = false;
          previousToken = "}";
          index += 1;
          continue;
        }
        if (character === "[") {
          canStartRegex = true;
          previousToken = "[";
        } else if (character === "]") {
          canStartRegex = false;
          previousToken = "]";
        } else if (character === ".") {
          canStartRegex = false;
          previousToken = ".";
        } else if (character === "+" && source[index + 1] === "+" ||
                   character === "-" && source[index + 1] === "-") {
          canStartRegex = false;
          previousToken = "update";
          index += 1;
        } else {
          canStartRegex = true;
          previousToken = "operator";
        }
        pendingControl = false;
        index += 1;
      }
      return {
        rejected: templateExpression || braces !== 0 ||
          controlParentheses.length !== 0,
        index,
      };
    };

    return scanCode(0, false, 0).rejected;
  };

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
      const source = $String(input.source || "");
      if (!authorityScrubbed || sourceIsUnsafe(source)) {
        finish({ ok: false, code: "automation_failed" });
        return;
      }
      if (!isCanonical(args) || !isCanonical(snapshot)) {
        finish({ ok: false, code: "serialization_failed" });
        return;
      }
      const page = pageApi(snapshot, plan);
      const execute = $Function(
        "args",
        "page",
        "\"use strict\";return (async()=>{" + source + "\n})()",
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
