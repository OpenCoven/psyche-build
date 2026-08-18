# iOS Coven Cave authentication parity

## Goal

Replace Psyche Build for iOS's demo host-and-six-digit-code pairing screen with
the authenticated invite procedure used by Coven Cave. A user connects only by
opening, pasting, or scanning a fresh Psyche invite; there is no separate
pairing credential or tokenless host path.

## Authentication contract

1. Psyche creates a signed, expiring invite through **Open on phone**. The URL
   contains a one-time `psyche_invite` and targets the Psyche host. The URL
   format is Psyche-specific (`psyche://connect` or an HTTPS equivalent): a
   Coven Cave URL cannot authenticate Psyche's separate WebSocket protocol.
2. The iOS app accepts Psyche deep links and HTTPS invite URLs. It normalizes
   and parses the URL before any network request.
3. The host exchanges a valid invite during the WebSocket hello for a
   long-lived Psyche device bearer. The iOS app stores the resulting canonical
   endpoint and bearer in the device-only secure store; raw credentials never
   enter view state, logs, analytics, error copy, or accessibility labels.
4. Every later WebSocket hello supplies the stored bearer. A credential is sent
   only to the exact endpoint established by the parsed invite.
5. Tokenless URLs, unsupported schemes, malformed invites, and expired or
   rejected credentials fail closed. The UI explains that the user must create
   a new **Open on phone** invite in Coven Cave.

Tailnet membership is routing, not authorization. The app must not retain or
reintroduce a host-only or manual-token fallback.

## User experience

Settings replaces **Pair a host** with **Connect to Psyche**. The sheet
offers a single invite input plus Paste and Scan actions. On success it shows
only the connected host identity; it never displays the credential. The empty
state directs the user to create an **Open on phone** invite in Coven Cave.

Reconnecting uses the persisted endpoint and bearer. Clearing the connection
removes both from secure storage and returns to the unauthenticated empty
state.

## Components and boundaries

- `PsycheInvite`: pure parser/normalizer for deep-link and HTTPS invite inputs.
- `MobileCredentialStore`: secure endpoint/token persistence and exact-origin
  credential binding.
- `ConnectPsycheSheet`: input-only UI that sends cleaned text to the parser and
  renders safe recovery copy.
- `ConnectionManager`: reconnects through `CaveConnection`; it owns transport
  transitions but never reads or exposes the raw credential to views.

The existing `PairHostSheet`, `PairedHostStore`, Bonjour discovery, and
six-digit pairing code path are removed unless another production caller still
needs them. No compatibility shim is kept for demo pairing records.

## Testing and acceptance

- Parser tests cover valid Psyche deep links/HTTPS invites and reject tokenless,
  malformed, wrong-scheme, and expired invites.
- Connection tests prove credentials persist only in the secure store and are
  sent only in a hello to the parsed endpoint.
- UI tests cover connect, paste, invalid-invite recovery, connected host
  display, and clear-connection behavior without exposing a token.
- Existing pairing UI and pairing-store tests are deleted or replaced; a source
  contract test asserts no six-digit pairing flow remains.
- Native unit/UI tests and the iOS build pass on the iPhone 16 Pro simulator.
