/**
 * Approval service (Milestone 5-A).
 *
 * Application operations for the human-approval workflow: submit
 * an approval request, approve it, reject it and list what is
 * pending.
 *
 * The service owns the `ApprovalManager` lifecycle so transports
 * (CLI, REST API) never manipulate approval state directly.
 */

import type { ApprovalManager } from '../approval/approval-manager.js';
import type {
  ApprovalActionType,
  ApprovalDecision,
  ApprovalRequest,
} from '../approval/approval-request.js';
import type { Clock } from '../core/types.js';
import { ValidationError } from '../core/errors.js';

/** Result of submitting an approval request. */
export interface ApprovalSubmission {
  readonly requestId: string;
  readonly status: 'PENDING_APPROVAL';
  readonly actionType: ApprovalActionType;
  readonly description: string;
}

/** The approval state of a single run, as the dashboard sees it. */
export type ApprovalRunState =
  | { readonly status: 'NONE' }
  | { readonly status: 'PENDING_APPROVAL' }
  | {
      readonly status: 'APPROVED' | 'REJECTED';
      readonly requestId: string;
      readonly comment?: string;
    };

/** A resolved approval outcome. */
export interface ApprovalResolution {
  readonly requestId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly comment?: string;
  readonly decidedAt: number;
}

/** Dependencies for the approval service. */
export interface ApprovalServiceDeps {
  readonly approvals: ApprovalManager;
  readonly clock: Clock;
}

/** The actions that may be submitted for approval. */
export const APPROVABLE_ACTIONS: readonly ApprovalActionType[] = [
  'COMMIT',
  'PUSH',
  'CREATE_PR',
  'EXECUTE_SAFE_COMMAND',
];

function isApprovalAction(value: string): value is ApprovalActionType {
  return (APPROVABLE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Application service for human approvals.
 *
 * Approval is deterministic and programmatic: decisions are
 * explicit calls rather than a UI interaction, so the same
 * sequence produces the same result in tests and demos.
 */
export class ApprovalService {
  private counter = 0;

  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Submit a request for approval and leave it pending.
   *
   * Returns a generated request id the caller can later approve
   * or reject.
   */
  submit(input: {
    readonly actionType: string;
    readonly description: string;
    readonly runId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): ApprovalSubmission {
    if (!isApprovalAction(input.actionType)) {
      throw new ValidationError(
        `Unknown approval action '${input.actionType}'; expected one of [${APPROVABLE_ACTIONS.join(', ')}]`,
      );
    }
    if (input.description.trim().length === 0) {
      throw new ValidationError('Approval description must not be empty');
    }

    // Monotonic ids keep replays deterministic within a process.
    this.counter += 1;
    const requestId = input.runId !== undefined
      ? `${input.runId}:approval:${this.counter}`
      : `approval:${this.counter}`;

    const request: ApprovalRequest = this.deps.approvals.createRequest(
      requestId,
      input.actionType,
      input.description,
      this.deps.clock.now(),
      {
        ...(input.metadata ?? {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
      },
    );

    // Tracked here so a run's approval state remains resolvable
    // after the request leaves the pending list.
    if (input.runId !== undefined) {
      this.requestRunIds.set(request.id, input.runId);
      this.requestOrder.push(request.id);
    }

    return {
      requestId: request.id,
      status: 'PENDING_APPROVAL',
      actionType: request.actionType,
      description: request.description,
    };
  }

  /** Approve a pending request. */
  approve(requestId: string, comment?: string): ApprovalResolution {
    const decision = this.deps.approvals.approve(
      requestId,
      this.deps.clock.now(),
      comment,
    );
    if (decision === undefined) {
      throw new ValidationError(`No pending approval request '${requestId}'`);
    }
    return this.toResolution(decision);
  }

  /** Reject a pending request. */
  reject(requestId: string, comment?: string): ApprovalResolution {
    const decision = this.deps.approvals.reject(
      requestId,
      this.deps.clock.now(),
      comment,
    );
    if (decision === undefined) {
      throw new ValidationError(`No pending approval request '${requestId}'`);
    }
    return this.toResolution(decision);
  }

  /** Fetch a pending request. */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.deps.approvals.getRequest(requestId);
  }

  /** Fetch a recorded decision. */
  getDecision(requestId: string): ApprovalDecision | undefined {
    return this.deps.approvals.getDecision(requestId);
  }

  /** List every pending request. */
  listPending(): ApprovalRequest[] {
    return this.deps.approvals.getPendingRequests();
  }

  /**
   * Pending requests associated with a specific run.
   *
   * The association comes from the `runId` recorded in the request
   * metadata by `submit`, so no approval state is duplicated.
   */
  listPendingForRun(runId: string): ApprovalRequest[] {
    return this.deps.approvals
      .getPendingRequests()
      .filter((request) => this.requestRunIds.get(request.id) === runId);
  }

  /**
   * Approval state for a run, as a single resolved value.
   *
   * Pending wins over resolved: a run with an outstanding request
   * reports `PENDING_APPROVAL` even if an earlier request for the
   * same run was already decided.
   */
  getStateForRun(runId: string): ApprovalRunState {
    if (this.listPendingForRun(runId).length > 0) {
      return { status: 'PENDING_APPROVAL' };
    }

    // Walk this service's requests newest-first so the last
    // decision for the run is reported.
    for (let i = this.requestOrder.length - 1; i >= 0; i -= 1) {
      const requestId = this.requestOrder[i]!;
      if (this.requestRunIds.get(requestId) !== runId) continue;
      const decision = this.deps.approvals.getDecision(requestId);
      if (decision !== undefined) {
        return {
          status: decision.decision,
          requestId: decision.requestId,
          ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
        };
      }
    }

    return { status: 'NONE' };
  }

  /** Resolve the run a request belongs to, when one was recorded. */
  runIdForRequest(requestId: string): string | undefined {
    return this.requestRunIds.get(requestId);
  }

  /** requestId -> runId, populated on submit. */
  private readonly requestRunIds = new Map<string, string>();
  /** Request ids in creation order, so "latest" is well defined. */
  private readonly requestOrder: string[] = [];

  private toResolution(decision: ApprovalDecision): ApprovalResolution {
    return {
      requestId: decision.requestId,
      decision: decision.decision,
      ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
      decidedAt: decision.decidedAt,
    };
  }
}