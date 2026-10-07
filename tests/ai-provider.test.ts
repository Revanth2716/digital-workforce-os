import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DeterministicLLMProvider } from '../src/providers/deterministic-llm-provider.js';
import { DeterministicProvider } from '../src/providers/deterministic-provider.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible-provider.js';
import {
  ProviderError,
  StructuredOutputError,
  TimeoutError,
} from '../src/core/errors.js';
import { AgentPlanSchema } from '../src/agents/schemas.js';
import type { AgentPlan } from '../src/agents/schemas.js';
import { fnv1a32 } from '../src/providers/random.js';
import { sha256Hex } from '../src/core/json.js';

/** A minimal valid plan for scripted responses. */
const VALID_PLAN = {
  objective: 'test objective',
  summary: 'test summary',
  tasks: [
    {
      id: 't1',
      name: 'task-one',
      description: 'do the thing',
      assignedAgent: 'researcher',
      tools: ['word_count'],
      dependsOn: [],
      expectedOutcome: 'findings produced',
    },
  ],
};

describe('DeterministicLLMProvider — LLM provider abstraction', () => {
  it('exposes provider name and model metadata', () => {
    const provider = new DeterministicLLMProvider();
    expect(provider.name).toBe('deterministic');
    expect(provider.model.provider).toBe('deterministic');
    expect(provider.model.name).toBe('deterministic-1');
    expect(provider.model.capabilities).toContain('text');
    expect(provider.model.capabilities).toContain('structured-output');
  });

  it('delegates text completion to the existing deterministic provider', async () => {
    const inner = new DeterministicProvider({ seed: 5 });
    const provider = new DeterministicLLMProvider({ inner });
    const request = { prompt: 'analyze the pipeline', options: { seed: 42 } };
    const viaAdapter = await provider.complete(request);
    const direct = await inner.complete(request);
    expect(viaAdapter.text).toBe(direct.text);
    expect(viaAdapter.provider).toBe('deterministic');
    expect(viaAdapter.finishReason).toBe('completed');
    expect(viaAdapter.usage.totalTokens).toBe(
      viaAdapter.usage.promptTokens + viaAdapter.usage.completionTokens,
    );
  });

  it('generates schema-valid structured output with zero network', async () => {
    const provider = new DeterministicLLMProvider();
    const completion = await provider.generateStructured<AgentPlan>({
      prompt: 'plan the migration',
      schema: AgentPlanSchema,
      intent: 'plan',
    });
    expect(completion.value.tasks.length).toBeGreaterThan(0);
    expect(completion.provider).toBe('deterministic');
    expect(completion.model).toBe('deterministic-1');
    expect(completion.finishReason).toBe('completed');
    expect(completion.usage.promptTokens).toBeGreaterThan(0);
    expect(completion.usage.completionTokens).toBeGreaterThan(0);
    expect(completion.usage.totalTokens).toBe(
      completion.usage.promptTokens + completion.usage.completionTokens,
    );
    expect(completion.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic: identical prompt, seed and schema produce identical output', async () => {
    const provider = new DeterministicLLMProvider();
    const request = {
      prompt: 'plan the migration',
      schema: AgentPlanSchema,
      intent: 'plan',
      options: { seed: 9 },
    };
    const first = await provider.generateStructured(request);
    const second = await provider.generateStructured(request);
    expect(first.value).toEqual(second.value);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.usage).toEqual(second.usage);
  });

  it('varies generated output with the seed', async () => {
    const provider = new DeterministicLLMProvider();
    const base = { prompt: 'plan the migration', schema: AgentPlanSchema, intent: 'plan' };
    const a = await provider.generateStructured({ ...base, options: { seed: 1 } });
    const b = await provider.generateStructured({ ...base, options: { seed: 2 } });
    expect(a.value).not.toEqual(b.value);
  });

  it('uses scripted responses keyed by intent', async () => {
    const provider = new DeterministicLLMProvider({
      responses: { plan: VALID_PLAN },
    });
    const completion = await provider.generateStructured<AgentPlan>({
      prompt: 'anything at all',
      schema: AgentPlanSchema,
      intent: 'plan',
    });
    expect(completion.value.summary).toBe('test summary');
    expect(completion.raw).toContain('test summary');
  });

  it('falls back to schema-guided generation for unscripted intents', async () => {
    const provider = new DeterministicLLMProvider({
      responses: { plan: VALID_PLAN },
    });
    const completion = await provider.generateStructured<AgentPlan>({
      prompt: 'a different intent',
      schema: AgentPlanSchema,
      intent: 'other',
    });
    // Generated, not scripted: still schema-valid.
    expect(completion.value.tasks.length).toBeGreaterThan(0);
  });

  it('computes the request hash from seed, intent and prompt', async () => {
    const provider = new DeterministicLLMProvider();
    const completion = await provider.generateStructured({
      prompt: 'hello',
      schema: AgentPlanSchema,
      intent: 'plan',
      options: { seed: 3 },
    });
    expect(completion.requestHash).toBe(sha256Hex('3\nplan\nhello'));
  });

  it('throws StructuredOutputError when a scripted response violates the schema', async () => {
    const provider = new DeterministicLLMProvider({
      responses: { plan: { objective: 'missing the rest' } },
    });
    const error = await provider
      .generateStructured({ prompt: 'x', schema: AgentPlanSchema, intent: 'plan' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).issues.length).toBeGreaterThan(0);
  });

  it('throws StructuredOutputError when generated output fails schema refinements', async () => {
    // The generator cannot know about `.refine()` predicates, so an
    // odd-number refinement fails roughly half the time — proving the
    // provider validates rather than trusting its own generation.
    const schema = z.object({ value: z.number().refine((n) => n % 2 === 1) });
    let threw = false;
    const provider = new DeterministicLLMProvider();
    for (let seed = 0; seed < 25 && !threw; seed++) {
      threw = await provider
        .generateStructured({ prompt: `refine ${seed}`, schema, options: { seed } })
        .then(() => false)
        .catch((e: unknown) => e instanceof StructuredOutputError);
    }
    expect(threw).toBe(true);
  });
});

describe('OpenAICompatibleProvider — optional external provider', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('refuses to construct without a base URL (no mandatory external service)', () => {
    expect(() => new OpenAICompatibleProvider({})).toThrow(ProviderError);
    expect(() => new OpenAICompatibleProvider({ baseURL: '  ' })).toThrow(
      ProviderError,
    );
  });

  it('falls back to OPENAI_BASE_URL from the environment', () => {
    process.env['OPENAI_BASE_URL'] = 'http://localhost:9/v1';
    try {
      const provider = new OpenAICompatibleProvider({
        fetchImpl: vi.fn(),
      });
      expect(provider.name).toBe('openai-compatible');
      expect(provider.model.name).toBe('gpt-4o-mini');
      expect(provider.model.capabilities).toContain('structured-output');
    } finally {
      delete process.env['OPENAI_BASE_URL'];
    }
  });

  it('sends a well-formed chat completion request with the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'hello back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        model: 'gpt-4o-mini',
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      apiKey: 'test-key',
      fetchImpl,
    });

    const completion = await provider.complete({ prompt: 'hello' });

    expect(completion.text).toBe('hello back');
    expect(completion.provider).toBe('openai-compatible');
    expect(completion.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(completion.requestHash).toMatch(/^[a-f0-9]{64}$/);

    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://localhost:9/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key',
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.temperature).toBe(0);
  });

  it('sends no Authorization header when no API key is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await provider.complete({ prompt: 'hello' });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('generates and validates structured output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_PLAN) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });

    const completion = await provider.generateStructured<AgentPlan>({
      prompt: 'plan this',
      schema: AgentPlanSchema,
      intent: 'plan',
    });

    expect(completion.value.summary).toBe('test summary');
    expect(completion.finishReason).toBe('completed');
    expect(completion.usage.promptTokens).toBe(10);
    expect(completion.usage.completionTokens).toBe(20);
    expect(completion.raw).toContain('test summary');

    // The structured-outputs response format was requested.
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.type).toBe('object');
  });

  it('maps finish_reason "length" to max_tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    const completion = await provider.complete({ prompt: 'hello' });
    expect(completion.finishReason).toBe('max_tokens');
  });

  it('throws StructuredOutputError for non-JSON model output', async () => {
    // A valid response envelope whose content is not JSON.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { content: 'not json at all' }, finish_reason: 'stop' },
        ],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await expect(
      provider.generateStructured({
        prompt: 'plan',
        schema: AgentPlanSchema,
        intent: 'plan',
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it('throws StructuredOutputError for schema-invalid model output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { content: JSON.stringify({ objective: 'incomplete' }) }, finish_reason: 'stop' },
        ],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    const error = await provider
      .generateStructured({ prompt: 'plan', schema: AgentPlanSchema, intent: 'plan' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).issues.length).toBeGreaterThan(0);
  });

  it('throws ProviderError on HTTP error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('throws ProviderError when the endpoint returns invalid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<<<not json>>>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow(
      ProviderError,
    );
  });

  it('throws ProviderError when the completion is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '' } }] }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow(
      ProviderError,
    );
  });

  it('throws ProviderError on network failure with the cause chained', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    const error = await provider.complete({ prompt: 'hello' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('ECONNREFUSED');
  });

  it('throws TimeoutError when the endpoint exceeds the time budget', async () => {
    // A fetch implementation that never settles (and ignores the
    // abort signal): the provider's internal race must still bound it.
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => {}),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
      timeoutMs: 25,
    });
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow(
      TimeoutError,
    );
  }, 5_000);

  it('honours request-level maxTokens and temperature options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:9/v1',
      fetchImpl,
    });
    await provider.complete({
      prompt: 'hello',
      options: { maxTokens: 128, temperature: 0.7 },
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.7);
  });
});

// Keep the deterministic provider's request-hash contract pinned:
// the adapter must not drift from the M1 provider's behaviour.
describe('deterministic request hash contract', () => {
  it('matches sha256 of seed and prompt for text completions', async () => {
    const provider = new DeterministicLLMProvider();
    const completion = await provider.complete({
      prompt: 'hello',
      options: { seed: 3 },
    });
    expect(completion.requestHash).toBe(sha256Hex('3\nhello'));
    expect(fnv1a32('hello')).toBeGreaterThan(0);
  });
});
