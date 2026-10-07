/**
 * Approval manager (Milestone 4).
 *
 * Manages the lifecycle of approval requests for sensitive
 * actions. Actions enter PENDING_APPROVAL state and pause
 * until APPROVED or REJECTED.
 *
 * For deterministic testing, the approval manager supports
 * programmatic approval/rejection. No UI is required.
 */

import type { ApprovalRequest, ApprovalDecision, ApprovalActionType } from './approval-request.js';

/** Callback invoked when an approval is needed. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Manages approval requests and their lifecycle.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly decisions = new Map<string, ApprovalDecision>();
  private readonly handler: ApprovalHandler | undefined;

  constructor(handler?: ApprovalHandler) {
    this.handler = handler;
  }

  /**
   * Create an approval request for a sensitive action.
   * Returns the request in PENDING_APPROVAL state.
   */
  createRequest(
    id: string,
    actionType: ApprovalActionType,
    description: string,
    createdAt: number,
    metadata?: Readonly<Record<string, unknown>>,
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      id,
      actionType,
      description,
      status: 'PENDING_APPROVAL',
      createdAt,
      metadata,
    };
    this.pending.set(id, request);
    return request;
  }

  /**
   * Get a pending request by id.
   */
  getRequest(id: string): ApprovalRequest | undefined {
    return this.pending.get(id);
  }

  /**
   * Check if a request is pending.
   */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Approve a pending request.
   */
  approve(id: string, decidedAt: number, comment?: string): ApprovalDecision | undefined {
    const request = this.pending.get(id);
    if (request === undefined) return undefined;

    const decision: ApprovalDecision = {
      requestId: id,
      decision: 'APPROVED',
      comment,
      decidedAt,
    };
    this.decisions.set(id, decision);
    this.pending.delete(id);
    return decision;
  }

  /**
   * Reject a pending request.
   */
  reject(id: string, decidedAt: number, comment?: string): ApprovalDecision | undefined {
    const request = this.pending.get(id);
    if (request === undefined) return undefined;

    const decision: ApprovalDecision = {
      requestId: id,
      decision: 'REJECTED',
      comment,
      decidedAt,
    };
    this.decisions.set(id, decision);
    this.pending.delete(id);
    return decision;
  }

  /**
   * Get a decision by request id.
   */
  getDecision(id: string): ApprovalDecision | undefined {
    return this.decisions.get(id);
  }

  /**
   * Request approval through the configured handler.
   * The handler is expected to return a decision.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    if (this.handler === undefined) return undefined;
    return this.handler(request);
  }

  /**
   * Get all pending requests.
   */
  getPendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  /**
   * Clear all pending requests and decisions.
   */
  clear(): void {
    this.pending.clear();
    this.decisions.clear();
  }
}
