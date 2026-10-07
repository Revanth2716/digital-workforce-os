import type { JsonValue } from '../core/json.js';

/** Options that shape a single completion request. */
export interface CompletionOptions {
  /** Seed makes output reproducible for the same prompt. */
  readonly seed?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface CompletionRequest {
  readonly prompt: string;
  readonly options?: CompletionOptions;
}

export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Provider-agnostic completion result. */
export interface Completion {
  readonly text: string;
  readonly provider: string;
  readonly finishReason: 'completed' | 'max_tokens';
  readonly usage: CompletionUsage;
  /** Stable hash identifying the exact request; used in evidence. */
  readonly requestHash: string;
}

/**
 * Provider abstraction. Milestone 1 ships only the deterministic
 * local provider; real LLM providers can be added later behind this
 * same interface without touching the orchestrator or agents.
 */
export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
}
