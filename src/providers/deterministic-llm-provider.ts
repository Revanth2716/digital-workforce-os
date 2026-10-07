import { z } from 'zod';
import type { JsonValue } from '../core/json.js';
import { canonicalJson, sha256Hex } from '../core/json.js';
import { StructuredOutputError } from '../core/errors.js';
import { fnv1a32, mulberry32 } from './random.js';
import type {
  Completion,
  CompletionRequest,
  Provider,
} from './provider.js';
import { DeterministicProvider } from './deterministic-provider.js';
import type {
  LLMProvider,
  ModelInfo,
  StructuredCompletion,
  StructuredCompletionRequest,
} from './llm-provider.js';
import { generateFromJsonSchema } from './json-schema-generate.js';

export interface DeterministicLLMProviderOptions {
  /** Default seed applied when a request does not specify one. */
  readonly seed?: number;
  /** Number of sentences for plain text completions. */
  readonly sentences?: number;
  /** Inner text provider. Defaults to a new `DeterministicProvider`. */
  readonly inner?: Provider;
  /**
   * Scripted structured responses keyed by intent
   * (e.g. `{ 'verify:1': { passed: true, ... } }`).
   * Used by demos and tests for fully controlled,
   * reproducible offline scenarios. Scripted responses
   * are validated against the requested schema exactly
   * like generated ones — an invalid scripted response
   * fails loudly with `StructuredOutputError`.
   */
  readonly responses?: Readonly<Record<string, JsonValue>>;
}

/**
 * The Milestone 2 adapter over the Milestone 1
 * `DeterministicProvider`.
 *
 * - `complete()` delegates to the existing deterministic
 *   provider, so text generation behaves exactly as before.
 * - `generateStructured()` produces schema-validated output
 *   fully offline: a scripted response when one exists for
 *   the intent, otherwise a schema-conforming instance
 *   generated deterministically from the Zod schema's JSON
 *   Schema form and the seeded PRNG.
 *
 * Same prompt + seed + schema always produces the same
 * output, usage counts and request hash. No network, no
 * API key, no external service.
 */
export class DeterministicLLMProvider implements LLMProvider {
  readonly name = 'deterministic';
  readonly model: ModelInfo = {
    provider: 'deterministic',
    name: 'deterministic-1',
    version: '1.0.0',
    capabilities: ['text', 'structured-output'],
    maxOutputTokens: 4096,
    contextWindow: 16384,
  };

  private readonly inner: Provider;
  private readonly seed: number;
  private readonly sentences: number;
  private readonly responses: Readonly<Record<string, JsonValue>>;

  constructor(private readonly options: DeterministicLLMProviderOptions = {}) {
    this.inner = options.inner ?? new DeterministicProvider(options);
    this.seed = options.seed ?? 0;
    this.sentences = options.sentences ?? 3;
    this.responses = options.responses ?? {};
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    return this.inner.complete(request);
  }

  async generateStructured<T>(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletion<T>> {
    const seed = request.options?.seed ?? this.seed;
    const promptSeed = fnv1a32(request.prompt);
    const rng = mulberry32((promptSeed ^ seed) >>> 0);
    const intent = request.intent ?? 'default';

    const scripted = this.responses[intent];
    let value: unknown;
    let raw: string;
    if (scripted !== undefined) {
      value = scripted;
      raw = canonicalJson(scripted);
    } else {
      // Export the Zod schema to JSON Schema and instantiate
      // it deterministically with the seeded PRNG.
      const jsonSchema = z.toJSONSchema(request.schema) as unknown as JsonValue;
      value = generateFromJsonSchema(jsonSchema, rng);
      raw = canonicalJson(value as JsonValue);
    }

    // Every model-generated structured output is validated
    // against the requested schema before it leaves the
    // provider — scripted or generated.
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      throw new StructuredOutputError(
        `Deterministic provider produced output that failed schema validation for intent '${intent}'`,
        { issues },
      );
    }

    const promptTokens = Math.max(1, Math.ceil(request.prompt.length / 4));
    const completionTokens = Math.max(1, Math.ceil(raw.length / 4));

    return {
      value: parsed.data as T,
      provider: this.name,
      model: this.model.name,
      finishReason: 'completed',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      requestHash: sha256Hex(`${seed}\n${intent}\n${request.prompt}`),
      raw,
    };
  }
}
