# Security policy

Psyche Build is a high-trust developer tool: it can present terminals, repositories, worktrees, agent/provider sessions, and consequential actions. Please report suspected vulnerabilities privately so maintainers can investigate without exposing users or giving attackers a public reproduction path.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow:

**[Report a vulnerability privately](https://github.com/OpenCoven/psyche-build/security/advisories/new)**

Do not open a public issue, pull request, discussion, or Bead for a suspected vulnerability. If GitHub does not show the private-report form, contact an OpenCoven maintainer through an already established private channel and ask them to enable or initiate a private GitHub Security Advisory. Do not send exploit details until the private channel and recipient are verified.

A useful private report contains only the minimum necessary evidence:

- the affected released version or exact commit SHA;
- affected platform and architecture;
- security boundary crossed and realistic impact;
- minimal, sanitized reproduction steps;
- whether exploitation requires local access, authentication, user confirmation, or a particular capability;
- suggested mitigations, when known.

Never include live credentials, access tokens, passwords, private keys, certificates, signing material, raw prompts, unrestricted terminal output, private repository contents, complete environment dumps, private service URLs, or unredacted personal paths. Revoke and rotate any secret that may already have been exposed.

## Response targets

These are operational targets, not a service-level agreement:

- acknowledge receipt within **3 business days**;
- provide an initial severity and scope assessment within **7 business days** when reproduction is possible;
- agree on coordinated-disclosure timing after a fix and supported upgrade path exist.

Maintainers may request a smaller reproduction, sanitized traces, or a private test build. Reporters should not access data or systems they do not own or have explicit authorization to test.

## Supported versions and platforms

Security fixes are considered for the latest published release and current `main`. Older releases are not guaranteed to receive backports. Platform availability and support claims are defined by [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md), not by source presence, hosted compilation, simulator success, or a roadmap entry.

A platform marked planned, compile-only, experimental, or unavailable is not a supported production surface. Security reports for those paths are still welcome because shared code may affect supported surfaces.

## Disclosure and credit

Please allow maintainers time to reproduce, remediate, test, and prepare safe upgrade guidance before public disclosure. When requested and legally permitted, OpenCoven will credit the reporter in the advisory or release notes. Anonymous reporting and no-credit requests are respected.

## Scope priorities

High-priority reports include, but are not limited to:

- project-boundary or filesystem-scope escape;
- authentication, capability, lease, approval, or revocation bypass;
- command execution without the required user action or authority;
- receipt, audit, persistence, recovery, or identity confusion that can hide or misattribute a consequential action;
- bridge, loopback, WebSocket, IPC, or deep-link boundary failures;
- unsafe secret retention or disclosure;
- signing, update, release, package, or CI supply-chain compromise;
- cross-project or cross-familiar data leakage.

General support requests, reliability bugs without a security boundary, and feature proposals belong in the public issue forms described by [`SUPPORT.md`](SUPPORT.md).