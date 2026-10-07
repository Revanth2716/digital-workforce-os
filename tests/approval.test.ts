import { describe, expect, it } from 'vitest';
import { ApprovalManager } from '../src/approval/approval-manager.js';

describe('Approval — pending', () => {
  it('creates a request in PENDING_APPROVAL state', () => {
    const manager = new ApprovalManager();
    const request = manager.createRequest(
      'req-1',
      'COMMIT',
      'Commit changes',
      Date.now(),
    );
    expect(request.status).toBe('PENDING_APPROVAL');
    expect(request.actionType).toBe('COMMIT');
    expect(manager.isPending('req-1')).toBe(true);
  });

  it('tracks multiple pending requests', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.createRequest('req-2', 'PUSH', 'Push', Date.now());
    expect(manager.getPendingRequests()).toHaveLength(2);
  });
});

describe('Approval — approve', () => {
  it('approves a pending request', () => {
    const manager = new ApprovalManager();
    const request = manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    const decision = manager.approve('req-1', Date.now(), 'LGTM');

    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('APPROVED');
    expect(decision!.requestId).toBe('req-1');
    expect(manager.isPending('req-1')).toBe(false);
  });

  it('records the approval decision', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.approve('req-1', Date.now());

    const decision = manager.getDecision('req-1');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('APPROVED');
  });
});

describe('Approval — reject', () => {
  it('rejects a pending request', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    const decision = manager.reject('req-1', Date.now(), 'Not safe');

    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('REJECTED');
    expect(manager.isPending('req-1')).toBe(false);
  });

  it('records the rejection decision', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.reject('req-1', Date.now());

    const decision = manager.getDecision('req-1');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('REJECTED');
  });
});

describe('Approval — execution blocked while pending', () => {
  it('does not allow execution while request is pending', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());

    // While pending, the request is not approved.
    const decision = manager.getDecision('req-1');
    expect(decision).toBeUndefined();
    expect(manager.isPending('req-1')).toBe(true);
  });

  it('allows execution after approval', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.approve('req-1', Date.now());

    const decision = manager.getDecision('req-1');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('APPROVED');
  });

  it('blocks execution after rejection', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.reject('req-1', Date.now());

    const decision = manager.getDecision('req-1');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('REJECTED');
  });
});

describe('Approval — handler', () => {
  it('supports custom approval handlers', async () => {
    const manager = new ApprovalManager(async (request) => ({
      requestId: request.id,
      decision: 'APPROVED' as const,
      comment: 'auto-approved',
      decidedAt: Date.now(),
    }));

    const request = manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    const decision = await manager.requestApproval(request);

    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('APPROVED');
  });

  it('returns undefined when no handler is configured', async () => {
    const manager = new ApprovalManager();
    const request = manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    const decision = await manager.requestApproval(request);

    expect(decision).toBeUndefined();
  });
});

describe('Approval — clear', () => {
  it('clears all pending requests and decisions', () => {
    const manager = new ApprovalManager();
    manager.createRequest('req-1', 'COMMIT', 'Commit', Date.now());
    manager.approve('req-1', Date.now());

    manager.clear();
    expect(manager.getPendingRequests()).toHaveLength(0);
    expect(manager.getDecision('req-1')).toBeUndefined();
  });
});
