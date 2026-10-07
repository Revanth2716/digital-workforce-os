import type { Clock, EvidenceId, RunId, TaskId } from '../core/types.js';
import type { IdGenerator } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import { hashJson } from '../core/json.js';
import type { TypedEventBus } from './event-bus.js';
import { buildEvent } from './events.js';

/**
 * Immutable, tamper-evident evidence record. `hash` is the SHA-256 of the
 * canonical JSON of the record excluding the hash itself, so any later
 * alteration of the record is detectable.
 */
export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly kind: string;
  readonly createdAt: number;
  readonly data: JsonValue;
  readonly hash: string;
}

/** Input for recording a new piece of evidence. */
export interface EvidenceInput {
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly kind: string;
  readonly data: JsonValue;
}

/**
 * Append-only evidence log. Every record is emitted as an
 * `evidence.recorded` event, which the persistence layer writes to SQLite;
 * records can never be updated or deleted through this API.
 */
export class EvidenceLog {
  constructor(
    private readonly bus: TypedEventBus,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  record(input: EvidenceInput): EvidenceRecord {
    const createdAt = this.clock.now();
    const withoutHash = {
      id: this.ids.evidenceId(),
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      createdAt,
      data: input.data,
    };
    const hash = hashJson(withoutHash as unknown as JsonValue);
    const record: EvidenceRecord = { ...withoutHash, hash };
    this.bus.emit(
      buildEvent(
        'evidence.recorded',
        {
          id: this.ids.eventId(),
          runId: input.runId,
          taskId: input.taskId,
          occurredAt: createdAt,
        },
        { evidenceId: record.id, kind: record.kind, data: record.data, hash: record.hash },
      ),
    );
    return record;
  }
}
