/**
 * Policy capabilities (Milestone 4).
 *
 * Defines the capabilities that can be granted to agents
 * and tools. Each capability maps to a policy decision:
 * ALLOW, DENY, or REQUIRE_APPROVAL.
 *
 * The policy engine evaluates every tool/action request
 * against these capabilities. Agents cannot bypass the
 * policy layer.
 */

/** All defined capabilities. */
export const CAPABILITIES = [
  'READ',
  'SEARCH',
  'KNOWLEDGE_RETRIEVE',
  'WRITE_WORKSPACE',
  'EXECUTE_SAFE_COMMAND',
  'COMMIT',
  'PUSH',
  'CREATE_PR',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The policy decision for a capability. */
export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

/** Default policy: which capabilities are allowed, denied, or require approval. */
export const DEFAULT_POLICY: Readonly<Record<Capability, PolicyDecision>> = {
  READ: 'ALLOW',
  SEARCH: 'ALLOW',
  KNOWLEDGE_RETRIEVE: 'ALLOW',
  WRITE_WORKSPACE: 'ALLOW',
  EXECUTE_SAFE_COMMAND: 'REQUIRE_APPROVAL',
  COMMIT: 'REQUIRE_APPROVAL',
  PUSH: 'REQUIRE_APPROVAL',
  CREATE_PR: 'REQUIRE_APPROVAL',
};

/** Check if a string is a valid capability. */
export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Get the default decision for a capability. */
export function getDefaultDecision(capability: Capability): PolicyDecision {
  return DEFAULT_POLICY[capability];
}
