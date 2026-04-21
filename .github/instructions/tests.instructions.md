---
applyTo: "tests/**/*.ts"
description: "Vitest guidance for this repo's TypeScript unit tests"
---

# Test instructions

- Mirror the existing Vitest style: use `vi.hoisted()` for shared mocks that are referenced from top-level `vi.mock()` factories.
- When re-importing a module under test, reset module state first with `vi.resetModules()` and keep mock setup close to the loader helper.
- Import module-under-test paths as `../src/*.js` from tests to match the NodeNext runtime layout.
- Prefer focused module-level tests that assert exact shell-safety decisions, permission mappings, cache behavior, or fallback behavior instead of broad end-to-end flows.
- Keep test doubles explicit and local to the behavior under test; do not introduce generic helpers that hide which dependency is being mocked.
