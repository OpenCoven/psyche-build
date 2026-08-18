# Psyche Build documentation site

Public documentation for Psyche Build. `docs/src/` is the authoritative source
for the published site. `docs/superpowers/` contains internal historical design
and implementation records; it is not public product guidance.

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
- Polished public docs layout for psyche
- psyche install, workflow, configuration, hook, and troubleshooting pages
- Agent catalog and keyboard shortcut reference

## v0.0.1 distribution

After the `v0.0.1` release and Cask are available, public macOS installation is
provided only by the signed Homebrew Cask:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

The iOS build `Psyche Build` `0.0.1 (1)` is internal TestFlight only for
authorized OpenCoven testers, conditional on its availability to their
TestFlight account. The Cask installs only `Psyche Build.app`. Source CLI
development uses the repository checkout and contributing guide:

```sh
node /path/to/psyche-build/psyche
```

The Node CLI is present in source/package output but is not an npm release.
Windows, Linux, Android, external TestFlight, and public App Store distribution
are unavailable in `0.0.1`.

## Structure

- `src/` - Authoritative public site source files
- `src/content/` - Documentation page content
- `public/` - Static assets
- `dist/` - Production build output (generated)
- `superpowers/` - Internal historical design and implementation records

## Related docs

- [Breaking changes](BREAKING-CHANGES.md)
- [Control-plane architecture](CONTROL-PLANE.md)
- [Psyche Build integrations](INTEGRATIONS.md)
- [Product spec](PRODUCT-SPEC.md)
- [Smoke test](SMOKE.md)
- [Release runbook](RELEASE.md)
- [Contributing](../CONTRIBUTING.md)
