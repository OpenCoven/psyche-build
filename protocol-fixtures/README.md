# Wire protocol fixtures

Shared JSON examples of every message on the Psyche bridge protocol, decoded by
**both** implementations:

- TypeScript host — `src/services/bridge/wireProtocol.ts`
  (`__tests__/bridge/wireProtocolContract.test.ts`)
- Swift iOS client — `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`
  (`native/ios/PsycheCore/Tests/PsycheCoreTests/WireProtocolContractTests.swift`)

The two implementations are hand-written mirrors of each other. Nothing in the
build links them, so a field renamed or a case added on one side is invisible
until an actual device fails to decode a real message.

These fixtures are the link. Each suite asserts three things:

1. **Completeness** — every message type its own union declares has a fixture.
   This is the anti-drift check: add a case on one side only, and that side
   fails here.
2. **Decodes** — every fixture parses into the union.
3. **Round-trips** — decode then re-encode reproduces the same JSON value.

## How the pieces fit

    fixtures.ts          typed source, compile-checked against the TS unions
      │  pnpm run fixtures:generate
      ▼
    *-messages.json      what the Swift suite reads

`fixtures.ts` types every payload through a `Complete<>` mapped type that
strips optionality, so a fixture must spell out **every** field. That is what
catches the drift JSON alone cannot: adding `foo?: string` to a payload leaves
untyped JSON perfectly valid, and the Swift mirror never learns the field
exists. With the typed source it is a compile error naming the exact fixtures
to update — which is the moment to update the Swift struct.

The host contract test asserts the checked-in JSON is byte-identical to what
the source emits, so the two cannot silently diverge.

> Note: this only binds via `tsconfig.test.json`, which reaches `fixtures.ts`
> through the test's import. The base `tsconfig.json` includes `src/**/*` only,
> so a bare `tsc --noEmit` will not check it — run `pnpm run typecheck`.

## Changing the protocol

Edit `fixtures.ts`, run `pnpm run fixtures:generate`, and commit both. If only
one implementation is updated:

- a **new message type** fails the completeness test on the side that has it
- a **new or renamed field** fails the compile of `fixtures.ts`
- **stale JSON** fails the up-to-date assertion

Field names here are the **wire** names. Swift uses `CodingKeys` to map its
`camelCaseID` properties onto the `camelCaseId` wire form (`paneID` →
`paneId`), so the fixtures follow the TypeScript spelling.
