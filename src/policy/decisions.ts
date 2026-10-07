/**
 * Policy decisions (Milestone 4).
 *
 * Structured policy decision with explanation and evidence.
 * Every policy evaluation produces a decision that can be
 * recorded in the evidence log.
 */

import type { Capability, PolicyDecision } from './capabilities.js';

/** A complete policy decision. */
export interface PolicyDecisionResult {
  /** The capability being evaluated. */
  readonly capability: Capability;
  /** The decision: ALLOW, DENY, or REQUIRE_APPROVAL. */
  readonly decision: PolicyDecision;
  /** Human-readable explanation. */
  readonly explanation: string;
  /** Optional evidence reference. */
  readonly evidence?: string;
}

/** Create an ALLOW decision. */
export function allow(capability: Capability, explanation?: string): PolicyDecisionResult {
  return {
    capability,
    decision: 'ALLOW',
    explanation: explanation ?? `capability '${capability}' is allowed`,
  };
}

/** Create a DENY decision. */
export function deny(capability: Capability, explanation?: string): PolicyDecisionResult {
  return {
    capability,
    decision: 'DENY',
    explanation: explanation ?? `capability '${capability}' is denied`,
  };
}

/** Create a REQUIRE_APPROVAL decision. */
export function requireApproval(capability: Capability, explanation?: string): PolicyDecisionResult {
  return {
    capability,
    decision: 'REQUIRE_APPROVAL',
    explanation: explanation ?? `capability '${capability}' requires approval`,
  };
}
