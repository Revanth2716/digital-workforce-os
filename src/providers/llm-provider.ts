import type { z } from 'zod';
import type {
  Completion,
  CompletionOptions,
  CompletionRequest,
  CompletionUsage,
  Provider,
} from './provider.js';

/** What a model is capable of. */
export type ModelCapability = 'text' | 'structured-output' | 'tool-calling';

/** Provider-neutral description of the model behind a provider. */
export interface ModelInfo {
  readonly provider: string;
  /** Model name/identifier as the provider knows it. */
  readonly name: string;
  readonly version?: string;
  readonly capabilities: readonly ModelCapability[];
  readonly maxOutputTokens?: number;
  readonly contextWindow?: number;
}

/**
 * A structured-generation request. `schema` is the contract the
 * model output must satisfy; every implementation must validate
 * the model output against it before returning.
 */
export interface StructuredCompletionRequest {
  readonly prompt: string;
  readonly schema: z.ZodType;
  /**
   * Semantic intent label for the request (e.g. `'plan'`,
   * `'verify:1'`). Providers may use it for routing, logging,
   * or — in the offline deterministic provider — for selecting
   * a scripted response in fully controlled scenarios.
   */
  readonly intent?: string;
  readonly options?: CompletionOptions;
}

/**
 * A validated structured completion. `value` has passed the
 * Zod schema; `usage` carries token metadata; `requestHash`
 * identifies the exact request for evidence and replay.
 */
export interface StructuredCompletion<T = unknown> {
  readonly value: T;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: 'completed' | 'max_tokens' | 'invalid_output';
  readonly usage: CompletionUsage;
  /** Stable hash identifying the exact structured request. */
  readonly requestHash: string;
  /** Raw model text, when the provider returned textual content. */
  readonly raw?: string;
}

/**
 * The LLM provider abstraction (Milestone 2). Extends the
 * Milestone 1 `Provider` seam with structured generation and
 * model metadata while keeping plain text generation, usage
 * metadata and the provider name.
 *
 * Implementations:
 * - `DeterministicLLMProvider` — fully offline adapter over the
 *   Milestone 1 deterministic provider (default; zero network).
 * - `OpenAICompatibleProvider` — optional OpenAI-compatible
 *   HTTP provider; requires explicit configuration, never
 *   mandatory.
 */
export interface LLMProvider extends Provider {
  /** Metadata about the model behind this provider. */
  readonly model: ModelInfo;
  /**
   * Generate output that is validated against `request.schema`.
   * Implementations must throw `StructuredOutputError` when the
   * model output does not satisfy the schema.
   */
  generateStructured<T>(request: StructuredCompletionRequest): Promise<StructuredCompletion<T>>;
}

/** Re-exported for convenience of AI-layer consumers. */
export type { Completion, CompletionRequest, CompletionUsage, Provider };
