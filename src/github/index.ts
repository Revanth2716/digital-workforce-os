/**
 * GitHub integration (Milestone 5-C).
 *
 * GitHub is **optional and never required**. Two paths exist:
 *
 *   - `GithubAdapter` talks to the real GitHub CLI when it is
 *     installed and authenticated, and reports honestly when it is
 *     not. It never fabricates success.
 *   - `GithubSimulator` produces deterministic, clearly-labelled
 *     `SIMULATED` results with no network access, so the portfolio
 *     demo runs identically offline.
 */
export * from './github-adapter.js';
export * from './github-simulation.js';