# Psyche Build Public Documentation Focus Design

## Problem

The repository publishes several user-facing documentation surfaces:

- the root `README.md`;
- the Vite documentation site under `docs/src/`;
- Markdown files included in the package archive;
- release, installation, security, workflow, and troubleshooting guides.

Some of those surfaces give standalone prominence to related OpenCoven
products, demos, or operational workflows. That makes the published
documentation read like a broader ecosystem portal instead of documentation
for Psyche Build.

## Decision

Psyche Build is the sole subject of every public documentation surface stored
in this repository.

Related products and agent tools may appear only when they explain a Psyche
Build capability, requirement, integration boundary, or supported workflow.
Their descriptions must be concise and subordinate to the Psyche Build task
the reader is trying to complete.

## Public Documentation Boundary

The cleanup covers:

- `README.md`;
- `docs/README.md`;
- `docs/src/index.html`, navigation, hero, and content modules;
- Markdown files listed in `package.json#files`;
- public release, installation, security, smoke-test, configuration, workflow,
  and troubleshooting guides;
- generated `docs/client/` output, rebuilt from `docs/src/`.

Internal historical records under `docs/superpowers/specs/` and
`docs/superpowers/plans/` remain unchanged. They document implementation
history and are not public product navigation.

## Content Rules

Each public page must:

1. identify a Psyche Build user goal;
2. explain Psyche Build behavior, setup, operation, or support;
3. mention third-party products only where necessary for that goal;
4. avoid standalone marketing, demos, roadmaps, or operational instructions
   for another product;
5. use the Psyche Build product name consistently;
6. link only to pages that remain inside the public documentation boundary or
   to necessary external dependencies.

Standalone Coven/OpenClaw pages are removed from public navigation and package
publication unless they can be reframed as a Psyche Build integration guide.
Useful integration details should move into the nearest Psyche Build workflow,
agent-support, troubleshooting, or control-surface page.

## Source and Generated Output

`docs/src/` is authoritative for the public site. The generated
`docs/client/` directory must be rebuilt through the existing docs build
command and must not be hand-edited.

Markdown package publication is controlled by `package.json#files`. Files that
do not primarily document Psyche Build are removed from that list; retained
files are renamed or rewritten when necessary so their purpose is explicit.

## Navigation

Public navigation is organized around Psyche Build user journeys:

- introduction and installation;
- core concepts and supported agents;
- pane, worktree, project, and multi-agent workflows;
- merging and pull requests;
- remote access and integrations;
- configuration and hooks;
- troubleshooting, security, and release information.

No navigation item is named after another product unless the page is an
explicit Psyche Build integration reference that cannot be described more
clearly by its Psyche Build function.

## Validation

The implementation must:

- inventory every public source and package-published Markdown file;
- scan public source for standalone non-Psyche product positioning;
- verify all internal links and navigation targets still resolve;
- run the existing docs production build;
- confirm generated `docs/client/` matches `docs/src/`;
- inspect the final package file list with `npm pack --dry-run`;
- verify internal `docs/superpowers/` history is unchanged.

## Scope

This work changes documentation content and publication boundaries only. It
does not remove supported integrations from Psyche Build, change product
behavior, rewrite internal historical specifications, or modify unrelated
source code.
