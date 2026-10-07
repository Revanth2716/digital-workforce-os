import type { Completion, CompletionRequest, Provider } from './provider.js';
import { sha256Hex } from '../core/json.js';
import { fnv1a32, mulberry32, pickRandom } from './random.js';

const SUBJECTS = [
  'data pipeline',
  'query plan',
  'schema migration',
  'index strategy',
  'cache layout',
  'retry policy',
  'task graph',
  'event stream',
] as const;

const FINDINGS = [
  'is consistent',
  'requires no changes',
  'benefits from partitioning',
  'shows improved locality',
  'is ready for rollout',
  'needs a follow-up pass',
] as const;

const ACTIONS = [
  'documented',
  'scheduled',
  'flagged for review',
  'applied safely',
  'recorded in the evidence log',
] as const;

export interface DeterministicProviderOptions {
  /** Default seed applied when a request does not specify one. */
  readonly seed?: number;
  /** Number of sentences generated per completion. Defaults to 3. */
  readonly sentences?: number;
}

/**
 * Completely offline "model". Given the same prompt and seed it always
 * produces the same text, token counts and request hash — which makes
 * every test and demo reproducible without an API key or network.
 */
export class DeterministicProvider implements Provider {
  readonly name = 'deterministic';

  constructor(private readonly options: DeterministicProviderOptions = {}) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    const seed = request.options?.seed ?? this.options.seed ?? 0;
    const promptSeed = fnv1a32(request.prompt);
    const rng = mulberry32((promptSeed ^ seed) >>> 0);

    const sentenceCount = request.options?.maxTokens
      ? Math.max(1, Math.min(8, Math.ceil(request.options.maxTokens / 20)))
      : this.options.sentences ?? 3;

    const sentences: string[] = [];
    for (let i = 0; i < sentenceCount; i++) {
      sentences.push(
        `Deterministic analysis: the ${pickRandom(rng, SUBJECTS)} ${pickRandom(rng, FINDINGS)} and has been ${pickRandom(rng, ACTIONS)}.`,
      );
    }
    const text = sentences.join(' ');
    const promptTokens = Math.max(1, Math.ceil(request.prompt.length / 4));
    const completionTokens = text.split(/\s+/).length;

    return {
      text,
      provider: this.name,
      finishReason: 'completed',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      requestHash: sha256Hex(`${seed}\n${request.prompt}`),
    };
  }
}
