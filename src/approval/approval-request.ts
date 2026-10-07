/**
 * Approval request types (Milestone 4).
 *
 * Sensitive actions (COMMIT, PUSH, CREATE_PR) must be able
 * to enter PENDING_APPROVAL state. The system pauses until
 * the action is APPROVED or REJECTED.
 */

/** The status of an approval request. */
export type ApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

/** The type of action requiring approval. */
export type ApprovalActionType = 'COMMIT' | 'PUSH' | 'CREATE_PR' | 'EXECUTE_SAFE_COMMAND';

/** An approval request. */
export interface ApprovalRequest {
  /** Unique request id. */
  readonly id: string;
  /** The action type. */
  readonly actionType: ApprovalActionType;
  /** Human-readable description of the action. */
  readonly description: string;
  /** The current status. */
  readonly status: ApprovalStatus;
  /** When the request was created (ms since epoch). */
  readonly createdAt: number;
  /** Optional metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** An approval decision. */
export interface ApprovalDecision {
  /** The request id this decision applies to. */
  readonly requestId: string;
  /** The decision: APPROVED or REJECTED. */
  readonly decision: 'APPROVED' | 'REJECTED';
  /** Optional comment. */
  readonly comment?: string;
  /** When the decision was made (ms since epoch). */
  readonly decidedAt: number;
}
