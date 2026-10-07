/**
 * Policy engine (Milestone 4).
 *
 * Capability-based policy evaluation for tool/action requests.
 * Every tool execution must pass through the policy engine.
 *
 * Capabilities: READ, SEARCH, KNOWLEDGE_RETRIEVE, WRITE_WORKSPACE,
 * EXECUTE_SAFE_COMMAND, COMMIT, PUSH, CREATE_PR.
 *
 * Decisions: ALLOW, DENY, REQUIRE_APPROVAL.
 */
export * from './capabilities.js';
export * from './decisions.js';
export * from './policy-engine.js';
