# Copilot instructions

- Start with `AGENTS.md`. It is the shared source of truth for architecture, commands, safety rules, and repo-wide conventions.
- Keep Copilot-specific rules here; move durable shared guidance back into `AGENTS.md` instead of duplicating it.
- Edit `src/**/*.ts` for behavior changes and rebuild `extension.mjs`; do not hand-edit the bundled output.
- When touching tests, follow `.github/instructions/tests.instructions.md`.
- Prefer the smallest relevant validation first:
  - `npm test -- tests/shell-safety.test.ts` for heuristic approval logic
  - `npm test -- tests/config.test.ts` for config persistence changes
  - `npm test -- tests/extension.test.ts` for pre-tool permission hook behavior
  - `npm test -- tests/classifier.test.ts` for nested classifier lifecycle behavior
  - `npm test -- tests/classifier-models.test.ts` for classifier model/provider listing and fallback behavior
- After code changes, finish with `npm test`, `npm run typecheck`, and `npm run build`.
- If you add more repo guidance later, put shared rules in `AGENTS.md` and reserve `.github/instructions/*.instructions.md` for Copilot-only path-scoped behavior.
