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

## Changing the protocol

Add or edit the fixture in the same change. If only one implementation is
updated, its completeness test fails and names the missing type.

Field names here are the **wire** names. Swift uses `CodingKeys` to map its
`camelCaseID` properties onto the `camelCaseId` wire form (`paneID` →
`paneId`), so the fixtures follow the TypeScript spelling.
