---
name: safe-code-change
description: Make bounded, verifiable code changes with proper testing and validation
version: 1.0.0
tags: [implementation, safety, testing]
---

# Safe Code Change

## When to use

Use this skill when implementing a feature, fixing a bug, or
refactoring existing code in a governed workflow system.

## Instructions

1. **Understand the change** — read the relevant code and tests
   before making any modification.
2. **Plan the change** — identify which files need to change and
   what the change accomplishes.
3. **Make minimal changes** — modify only what is necessary.
   Do not refactor unrelated code.
4. **Add or update tests** — every behavioral change must have
   a corresponding test.
5. **Run the test suite** — verify all tests pass before
   considering the change complete.
6. **Record evidence** — document what changed and why.

## Output format

- **Files changed**: list of modified files
- **Tests added/updated**: list of test changes
- **Verification**: test results, typecheck results

## Constraints

- Never delete or overwrite existing tests.
- Never introduce network dependencies or paid services.
- Never bypass the ToolRegistry for file access.
- All changes must be deterministic and reproducible.
