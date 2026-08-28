# Support

Psyche Build is developed in public, but source presence does not mean a platform, integration, or workflow is supported. Start with the current [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Choose the right route

| Need | Route |
|---|---|
| Reproducible product bug on a supported surface | [Bug report](https://github.com/OpenCoven/psyche-build/issues/new?template=bug.yml) |
| Product or workflow proposal | [Feature request](https://github.com/OpenCoven/psyche-build/issues/new?template=feature.yml) |
| Incorrect, missing, or stale documentation | [Documentation report](https://github.com/OpenCoven/psyche-build/issues/new?template=documentation.yml) |
| Suspected security vulnerability | [Private vulnerability report](https://github.com/OpenCoven/psyche-build/security/advisories/new) — never a public issue |
| Implementation contribution | [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/CONTRIBUTOR-SAFETY.md`](docs/CONTRIBUTOR-SAFETY.md) |

Search existing issues before filing a new one. Keep each issue to one observable outcome so ownership, acceptance, and closure remain clear.

## What a useful public report includes

Provide the smallest safe evidence needed to understand the problem:

- Psyche Build release or exact commit SHA;
- operating system, version, and architecture;
- the supported user path being exercised;
- concise reproduction steps using disposable or non-sensitive data;
- expected and observed behavior;
- a bounded, sanitized evidence excerpt when text is necessary;
- whether the problem is deterministic, intermittent, or recovery-related.

A passing unit test, screenshot, source file, simulator build, or hosted compilation result does not by itself prove a complete production path. State exactly what was observed and what remains untested.

## Public-data safety

Public issues and pull requests are retained and searchable. Do **not** include:

- credentials, tokens, passwords, private keys, certificates, or signing material;
- raw prompts or conversation content;
- unrestricted terminal output or complete command history;
- private repository contents or proprietary source;
- complete environment dumps;
- private service URLs, internal hostnames, IP addresses, or account identifiers;
- unredacted home-directory, customer, device, or personal paths;
- vulnerability details or exploit steps.

Use synthetic names and paths, remove unrelated lines, replace identifiers consistently, and describe omitted fields. If safe redaction would remove the evidence needed to reproduce the report, use the private security route or ask a maintainer for a verified private channel before sharing it.

## Support boundaries

- The support matrix is authoritative for platform status.
- Roadmap entries are plans, not availability claims.
- Experimental, planned, compile-only, or unavailable paths may change without compatibility guarantees.
- Optional third-party providers remain subject to their own availability, authentication, rate, and policy boundaries.
- Maintainers cannot recover third-party credentials, private repository access, signing identities, or data not retained by Psyche Build.
- Consequential actions must remain bounded by the documented authority, confirmation, receipt, revocation, and recovery contracts.

## Maintainer response

Response time depends on severity, reproducibility, maintainer availability, and whether the report falls inside the supported surface. Maintainers may close reports that cannot be reproduced, duplicate an existing outcome, concern an explicitly unsupported path, or cannot be made safe for a public tracker. A closure should explain the controlling support or evidence boundary.