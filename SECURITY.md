# Security Policy

Thanks for helping keep Archie HQ and its users safe. This document explains how to report a vulnerability and gives a short overview of the project's security model.

## Reporting a Vulnerability

**Please report security issues privately. Do not open a public GitHub issue or pull request for a vulnerability.**

Preferred channel:

- **GitHub private security advisories** — go to the repository's **Security** tab and click **"Report a vulnerability"**. This opens a private advisory visible only to maintainers.

Alternative channel:

- **Email** — `<security@your-org — set before publishing>`

### What to include

To help us triage quickly, please include as much of the following as you can:

- A clear description of the issue and the impact you believe it has.
- Steps to reproduce (a proof of concept, script, or sample input is ideal).
- Affected component(s) and, if known, the relevant commit or version.
- Your environment (OS, Node.js version, how Archie was deployed).
- Any suggested remediation or mitigations.

### What to expect

We aim to acknowledge new reports within a few business days. After acknowledgement we'll work with you to confirm the issue, assess its severity, and develop a fix. We'll keep you updated on progress and let you know when a fix is released. Please give us a reasonable opportunity to address the issue before any public disclosure.

## Supported Versions

Archie HQ is early-stage software. Security fixes target the **latest `main`**. We do not currently maintain backported releases or long-term support branches, so please track `main` for the most recent fixes.

## Security Model (Trust Boundary)

Archie runs autonomous AI agents that read code, reason, and — once approved — make changes. The engine is built around defense-in-depth so that an agent (or a prompt-injected one) is constrained even if it behaves unexpectedly. Reporters should understand these boundaries when assessing impact:

- **Per-agent filesystem isolation** — each agent runs in a sandbox (bubblewrap on Linux) that restricts which paths it can read and write.
- **Network deny-all from agent Bash** — agents cannot make arbitrary outbound network calls from their shell. Web access is available only through a controlled research pipeline.
- **Tool denylists** — agents are restricted to an allowed set of tools; dangerous operations are blocked.
- **Human approval gate for edit mode** — agents are read-only by default. Making code changes (edit mode) requires explicit human approval.
- **Git safety** — force pushes are disallowed, and pushing is blocked from agent Bash.

These are layers, not guarantees — a bypass of any single layer is a legitimate report. For the full threat model and the assumptions behind each control, see [`docs/architecture/security.md`](docs/architecture/security.md).

## Operator Responsibilities

Archie HQ is provided **"as is", without warranty of any kind**, as set out in the [AGPL-3.0-or-later](LICENSE) license. If you deploy Archie, you are responsible for the security of your own deployment, including:

- Protecting API keys, tokens, and other secrets (never commit them; keep `.env` out of version control).
- Securing the host and runtime environment the agents run on.
- Reviewing agent changes before merging or shipping them.

Slack and GitHub are optional integrations; if you enable them, secure their credentials and scopes accordingly.
