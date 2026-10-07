/**
 * Human approval system (Milestone 4).
 *
 * Sensitive actions (COMMIT, PUSH, CREATE_PR) must be able
 * to enter PENDING_APPROVAL state. The system pauses until
 * APPROVED or REJECTED.
 *
 * For deterministic testing, the approval manager supports
 * programmatic approval/rejection. No UI is required.
 */
export * from './approval-request.js';
export * from './approval-manager.js';
