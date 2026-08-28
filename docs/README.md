# Psyche Build documentation site

Public documentation for Psyche Build. `docs/src/` is the authoritative source
for the published documentation site. Repository Markdown documents define the
product, delivery, security, architecture, and contributor contracts that are
not yet represented in the site.

## Documentation authority

Use these sources in this order when determining current delivery status:

1. The [owning GitHub issue](https://github.com/OpenCoven/psyche-build/issues)
   or [pull request](https://github.com/OpenCoven/psyche-build/pulls) — live
   ownership, implementation state, blockers, review findings, and evidence.
2. [Roadmap](ROADMAP.md) — active outcomes, priorities, dependencies, delivery
   trains, and phase-gate policy.
3. [Post-release execution contract](POST-RELEASE-EXECUTION.md) — the ordered
   critical path, permitted concurrency, focused replacement slices, and merge
   and closure gates.
4. [Support matrix](SUPPORT-MATRIX.md) — the contract for what may be claimed
   as supported, source-supported, planned, internal beta, compile-only, or
   unavailable.
5. [Release acceptance](RELEASE-ACCEPTANCE.md) and
   [release runbook](RELEASE.md) — proof requirements and publication
   procedures.
6. Dated specs and plans — design intent and historical reasoning.

The roadmap, execution contract, and support matrix are policy and
reconciliation snapshots. When a snapshot conflicts with the owning issue or
pull request, treat the live GitHub state as authoritative and repair the
snapshot in the same controlled change.

`docs/superpowers/` contains dated design and implementation records. Those
records remain useful history, but they are not the executable backlog and do
not prove that a capability shipped.

## Development

```bash
# Install dependencies (from docs directory)
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Features

- Single-page app with scroll-spy navigation
- Polished public docs layout for Psyche Build
- Installation, workflow, configuration, hook, and troubleshooting pages
- Agent catalog and keyboard shortcut reference

## `v0.0.1` distribution contract

The `v0.0.1` macOS release was published on 2026-08-23. The supported public
installation path is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

The immutable
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1)
contains signed and notarized Apple Silicon and Intel DMGs plus checksums, and
the public Cask is maintained in
[`OpenCoven/homebrew-tap`](https://github.com/OpenCoven/homebrew-tap/blob/main/Casks/psyche-build.rb).

An internal TestFlight companion is planned under
[#200](https://github.com/OpenCoven/psyche-build/issues/200). This repository
does not claim a live TestFlight build until #200 links distributed-build and
physical-device acceptance evidence. The planned companion remains restricted
to authorized OpenCoven testers; it is not an external TestFlight or public App
Store release.

The Cask installs only `Psyche Build.app`. Source CLI development uses the
repository checkout and contributing guide:

```sh
node /path/to/psyche-build/psyche
```

The Node CLI is present in source/package output but is not an npm release.
Windows and Linux are compile-only targets for this release; Android, external
TestFlight, and public App Store distribution are unavailable. See the
[support matrix](SUPPORT-MATRIX.md) for the complete contract.

## Structure

- `src/` — authoritative public site source files
- `src/content/` — documentation page content
- `public/` — static assets
- `dist/` — generated production build output
- `superpowers/` — dated internal design and implementation records

## Active delivery documents

- [Canonical roadmap](ROADMAP.md)
- [Post-release execution contract](POST-RELEASE-EXECUTION.md)
- [Support matrix](SUPPORT-MATRIX.md)
- [Release acceptance](RELEASE-ACCEPTANCE.md)
- [Release runbook](RELEASE.md)
- [Smoke test](SMOKE.md)

## Product, architecture, and security

- [Product spec](PRODUCT-SPEC.md)
- [Control-plane architecture](CONTROL-PLANE.md)
- [Agent surface control](AGENT-SURFACE-CONTROL.md)
- [Bridge and daemon security model](BRIDGE-SECURITY.md)
- [Psyche Build integrations](INTEGRATIONS.md)
- [Breaking changes](BREAKING-CHANGES.md)

## Contributing

- [Contributing guide](../CONTRIBUTING.md)
- [Repository test guide](https://github.com/OpenCoven/psyche-build/blob/main/__tests__/README.md)

When a change alters support status, roadmap dependencies, execution order, or
release evidence, update the relevant active delivery document and owning
GitHub issue in the same pull request.
