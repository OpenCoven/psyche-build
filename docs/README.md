# psyche Documentation Site

Single-page marketing and documentation site for psyche.

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

- `src/` - Source files
- `src/content/` - Documentation page content
- `public/` - Static assets
- `dist/` - Production build output (generated)

## Related docs

- [Breaking changes](BREAKING-CHANGES.md)
- [Coven sessions](COVEN-SESSIONS.md)
- [psyche + Coven demo loop](COVEN-DEMO-LOOP.md)
- [Product spec](PRODUCT-SPEC.md)
- [Smoke test](SMOKE.md)
- [Release runbook](RELEASE.md)
- [Contributing](../CONTRIBUTING.md)
