# Support

## Supported product state

The supported public installation is the latest stable macOS release documented
in `README.md` and `docs/SUPPORT-MATRIX.md`. Source checkouts are supported for
development and verification, but they are not equivalent to a signed public
release.

The iOS companion remains a planned internal-beta surface. Windows and Linux
desktop builds are compile-checked where documented but are not current public
distribution targets.

## Where to ask

- Reproducible product defects: use the **Bug report** issue form.
- Product outcomes and bounded feature proposals: use the **Feature request**
  form.
- Incorrect, stale, or missing documentation: use the **Documentation** form.
- Managed roadmap state: update Beads with `bd`; the GitHub Project is a
  one-way sanitized mirror.
- Security vulnerabilities: follow `SECURITY.md` and report privately.

Issues are public. Before submitting, remove access tokens, task credentials,
signing material, raw prompts, private repository contents, complete environment
dumps, user home paths, and unredacted terminal/browser output.

## What to include

A supportable report should identify:

- release/version or exact commit SHA;
- platform and affected surface;
- expected and observed behavior;
- minimal steps using a disposable repository or synthetic fixture;
- whether work, credentials, or authority may be stranded;
- recovery or rollback already attempted; and
- focused, redacted evidence.

Prefer the smallest reproducible contract failure over a full machine dump.

## Triage expectations

Maintainers may ask for a smaller reproduction, additional redaction, or proof
that the report still reproduces on a supported surface. A report may be closed
or redirected when it is:

- a security disclosure posted publicly;
- unsupported distribution or platform work;
- missing enough information to reproduce;
- a managed Beads item edited only in its GitHub mirror;
- a general request to expose credentials or private data; or
- an unbounded redesign without an observable outcome.

Support is best-effort and does not include an SLA. Release, publication,
credential, destructive cleanup, and remote mutation work always remains
maintainer-approved.
