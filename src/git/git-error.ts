/**
 * Git error types (Milestone 5-C).
 *
 * Distinct codes so callers can tell "git is not installed" from
 * "the workspace is not a repository" from "the policy refused",
 * without parsing message strings.
 */

import { DomainError } from '../core/errors.js';
import type { ErrorCode } from '../core/errors.js';

/** Git-specific error codes, added to the shared union. */
export type GitErrorCode = Extract<ErrorCode, 'git_unavailable' | 'git_failed'>;

/** A git command failed. Carries the exit code and stderr. */
export class GitError extends DomainError {
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(message: string, options: { readonly exitCode?: number; readonly stderr?: string } = {}) {
    super('git_failed', message, {
      details: {
        ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
        ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
      },
    });
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? '';
  }
}

/** Git is not installed, or the workspace is not a repository. */
export class GitNotAvailableError extends DomainError {
  constructor(message: string) {
    super('git_unavailable', message);
  }
}