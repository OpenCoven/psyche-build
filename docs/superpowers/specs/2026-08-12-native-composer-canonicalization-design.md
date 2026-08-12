# Native composer DOM canonicalization

## Problem

The native macOS `index.html` contains one complete composer inside
`#footer-stack`, followed by a second partial copy of composer controls after
the status menu. The duplicate introduces repeated IDs for `composer-mic`,
`composer-send`, `scope-menu`, its descriptions, and `palette`. Because the
orphan controls are direct children of the footer grid, the second microphone
renders as a stray row below the real composer. Duplicate menu IDs also make
the scope popup's anchor and state ambiguous.

The second block contains the only `composer-call` button and `call-bar`, so it
cannot simply be deleted without preserving voice-call UI behavior.

## Approved behavior

`#footer-stack` contains exactly one `<footer id="composer">`. That composer
owns exactly one copy of every composer control:

- scope button and scope menu;
- command input and send hint;
- microphone, voice-call, and send buttons;
- voice-call status bar; and
- command palette.

The voice-call button sits beside the microphone and send controls in the
canonical composer. The absolutely positioned call bar remains a child of the
composer so its existing `bottom: calc(100% - 4px)` rule anchors it above the
composer without moving the footer. The scope menu and palette remain children
of the same positioned composer and continue to open upward.

The orphan duplicate block and its unmatched closing `</footer>` are removed.
No CSS redesign, sizing change, voice behavior change, or status-bar behavior
change is included.

## Accessibility and DOM contract

Every composer-related ID occurs once. Existing labels, roles, `hidden`
defaults, keyboard shortcuts, and JavaScript lookup IDs remain unchanged. This
restores deterministic `getElementById` behavior and prevents assistive
technology from encountering duplicate control identities.

## Verification

Focused source-contract tests must prove:

- all composer and call control IDs occur exactly once;
- `composer-call`, `call-bar`, `scope-menu`, and `palette` are contained within
  the one canonical composer;
- footer order remains composer, optional detail, status bar, status menu, live
  region, and alert;
- the voice-call model and upward-positioning CSS contracts still pass; and
- native web build and TypeScript checks remain green.
