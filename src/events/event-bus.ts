import type { WorkflowEvent, WorkflowEventOfType, WorkflowEventType } from './events.js';

/** Handler for events of a specific type. */
export type TypedEventHandler<K extends WorkflowEventType> = (
  event: WorkflowEventOfType<K>,
) => void;

/** Handler for events of any type. */
export type AnyEventHandler = (event: WorkflowEvent) => void;

/**
 * Synchronous, in-memory typed event bus.
 *
 * Dispatch is synchronous so that ordering is deterministic: an event is
 * fully handled (including persistence, which subscribes via `onAny`)
 * before the emitting code continues. Listener exceptions propagate to the
 * emitter, which is intentional — a failing audit write must not be
 * silently swallowed.
 */
export class TypedEventBus {
  private readonly handlers = new Map<WorkflowEventType, Set<AnyEventHandler>>();
  private readonly anyHandlers = new Set<AnyEventHandler>();

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<K extends WorkflowEventType>(type: K, handler: TypedEventHandler<K>): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const erased = handler as AnyEventHandler;
    set.add(erased);
    return () => {
      set?.delete(erased);
    };
  }

  /** Subscribe to every event type. Returns an unsubscribe function. */
  onAny(handler: AnyEventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /** Dispatch an event to `onAny` subscribers first, then type subscribers. */
  emit(event: WorkflowEvent): void {
    for (const handler of this.anyHandlers) {
      handler(event);
    }
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(event);
    }
  }

  listenerCount(type?: WorkflowEventType): number {
    if (type !== undefined) {
      return (this.handlers.get(type)?.size ?? 0) + this.anyHandlers.size;
    }
    let total = this.anyHandlers.size;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }
}
