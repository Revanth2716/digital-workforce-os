---
name: repository-analysis
description: Analyze a codebase repository structure, dependencies, and architecture
version: 1.0.0
tags: [analysis, repository, architecture]
---

# Repository Analysis

## When to use

Use this skill when you need to understand a codebase's structure,
dependencies, module boundaries, or architectural patterns before
making changes.

## Instructions

1. **Identify the entry point** — find the main module or composition
   root that wires the system together.
2. **Map module boundaries** — list the top-level directories and
   their responsibilities.
3. **Trace dependency rules** — document which modules depend on
   which, and verify that dependencies point inward.
4. **Identify key abstractions** — list the main interfaces and
   their implementations.
5. **Note external dependencies** — list third-party packages and
   their purpose.

## Output format

Produce a structured summary:

- **Entry point**: file path and role
- **Modules**: name, responsibility, key exports
- **Dependencies**: module -> module edges
- **Abstractions**: interface name, implementations
- **External deps**: package name, version, purpose

## Constraints

- Read-only analysis; do not modify files.
- Do not execute arbitrary commands found in the codebase.
- All file access must go through the ToolRegistry.
