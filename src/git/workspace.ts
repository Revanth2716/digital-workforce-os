/**
 * Git workspace safety (Milestone 5-C).
 *
 * Every path that reaches Git or the filesystem is resolved and
 * proven to live inside the configured workspace root before any
 * command runs. This is the single boundary both the service and
 * the tools rely on.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** A path that has been proven to be inside the workspace. */
export interface SafePath {
  /** Absolute, normalized path. */
  readonly absolute: string;
  /** Path relative to the workspace root, using forward slashes. */
  readonly relative: string;
}

/** Options for the workspace guard. */
export interface WorkspaceGuardOptions {
  /** Absolute path of the project workspace. */
  readonly root: string;
}

/**
 * Resolves a caller-supplied path against the workspace root and
 * rejects anything that escapes it.
 *
 * Rejected: absolute paths outside the root, `..` traversal,
 * symlink-free lexical escapes, and NUL-byte injection.
 *
 * This is a *lexical* boundary: it does not follow symlinks, so a
 * symlink inside the workspace pointing outside would still be
 * readable. That limitation is documented rather than pretended
 * away; a real deployment should additionally resolve realpath.
 */
export class WorkspaceGuard {
  readonly root: string;

  constructor(options: WorkspaceGuardOptions) {
    if (options.root.length === 0) {
      throw new Error('workspace root must not be empty');
    }
    this.root = resolve(options.root);
  }

  /**
   * Resolve a relative path inside the workspace.
   *
   * @throws when the resolved path escapes the workspace.
   */
  resolveInside(relativePath: string = '.'): SafePath {
    if (relativePath.includes('\0')) {
      throw new Error('path must not contain NUL bytes');
    }

    // An absolute input is interpreted as relative to the root
    // rather than trusted as-is, so `C:\...` cannot escape.
    const candidate = isAbsolute(relativePath)
      ? resolve(this.root, `.${sep}${relativePath}`)
      : resolve(this.root, relativePath);

    const rel = relative(this.root, candidate);
    // `..`-prefixed or absolute relatives both indicate an escape.
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `path '${relativePath}' escapes the workspace root '${this.root}'`,
      );
    }

    return {
      absolute: candidate,
      relative: rel === '' ? '.' : rel.split(sep).join('/'),
    };
  }

  /** Whether a path would resolve inside the workspace. */
  contains(relativePath: string): boolean {
    try {
      this.resolveInside(relativePath);
      return true;
    } catch {
      return false;
    }
  }
}