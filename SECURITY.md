# Security Policy

Psyche Build coordinates terminal processes, Git worktrees, local credentials,
browser and pane control, release artifacts, and optional external providers.
Treat security reports as potentially sensitive even when the observed impact
appears local.

The current product boundary is defined in [`SUPPORT.md`](SUPPORT.md) and
[`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md). A security report does not
expand an unsupported surface into a supported distribution claim.

## Supported surfaces

| Surface | Security support |
|---|---|
| Latest stable macOS release (`v0.0.1`) | Supported |
| Current `main` source checkout | Receives fixes; not a stable distribution claim |
| iOS companion | Planned internal beta; not currently supported |
| Windows and Linux desktop builds | Compile-checked; not currently distributed |
| Legacy `comux` releases | Unsupported |

A newer release supersedes an older release unless its release notes say
otherwise.

## Report a vulnerability privately

Do **not** open a public issue with vulnerability details.

Use GitHub's private security-advisory route:

https://github.com/OpenCoven/psyche-build/security/advisories/new

If GitHub does not expose that form to your account, open a minimal public issue
that says only that you need a private maintainer contact. Do not name affected
users or repositories and do not include exploit details in that issue.

A useful private report includes:

- affected version, release, or commit SHA;
- affected platform and surface;
- impact and required attacker position;
- a minimal reproduction using synthetic, disposable data;
- whether recovery, revocation, or cleanup is required;
- mitigations already attempted; and
- a safe way to contact the reporter.

Never include real access tokens, signing material, task credentials, raw
prompts, private repository contents, complete environment dumps, user home
paths, or unredacted terminal/browser transcripts.

## High-priority scope

Reports are especially important when they affect:

- task-bound authentication or subject rotation;
- capability leases, approvals, receipts, or replay isolation;
- bridge and control-socket authorization;
- path confinement, symlink/hardlink handling, or worktree cleanup;
- secrets, local credential storage, or provider invocation;
- GitHub/Beads mutation authority;
- updater, signing, notarization, release, or artifact integrity; or
- cross-project, cross-task, or cross-user data exposure.

## Maintainer handling

Maintainers should:

1. keep the report and reproducer private;
2. identify the smallest affected trust boundary;
3. reproduce with synthetic data;
4. record containment, recovery, and revocation requirements;
5. prepare regression evidence before disclosure;
6. coordinate a release or mitigation when required; and
7. credit the reporter unless they request otherwise.

This project does not promise a response-time SLA. Maintainers should still
acknowledge actionable reports as promptly as practical and avoid public
disclosure until affected users have a reasonable mitigation path.
