# Working on Archie

Read [the coding guidelines](docs/guides/coding-guidelines.md) before changing code and use their review rubric before handoff. Keep rules in that guide; do not duplicate them in tool-specific files.

- Use the owning architecture document in `docs/architecture/` to place changes. Domain capabilities belong in plugins.
- When changing memory, also read `src/memory/CLAUDE.md`; its scoped invariants still apply.
- Run `npm run check` before handing off code changes. Use focused checks during iteration. See the guide for lint debt, formatting and runtime verification.
- Use the unified logger in application code. Standalone tools retain their stdout/stderr contracts.
- Preserve the generated changelog, prompts and skill text unless changing them is the task.
