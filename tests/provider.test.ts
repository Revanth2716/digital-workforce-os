import { describe, expect, it } from 'vitest';
import { DeterministicProvider } from '../src/providers/deterministic-provider.js';
import { sha256Hex } from '../src/core/json.js';

describe('DeterministicProvider', () => {
  it('produces identical output for identical prompt and seed', async () => {
    const provider = new DeterministicProvider();
    const a = await provider.complete({ prompt: 'analyze the pipeline', options: { seed: 42 } });
    const b = await provider.complete({ prompt: 'analyze the pipeline', options: { seed: 42 } });
    expect(a.text).toBe(b.text);
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.usage).toEqual(b.usage);
  });

  it('varies output with the seed', async () => {
    const provider = new DeterministicProvider();
    const a = await provider.complete({ prompt: 'same prompt', options: { seed: 1 } });
    const b = await provider.complete({ prompt: 'same prompt', options: { seed: 2 } });
    expect(a.text).not.toBe(b.text);
  });

  it('varies output with the prompt', async () => {
    const provider = new DeterministicProvider();
    const a = await provider.complete({ prompt: 'one', options: { seed: 1 } });
    const b = await provider.complete({ prompt: 'two', options: { seed: 1 } });
    expect(a.text).not.toBe(b.text);
  });

  it('uses the provider-level default seed', async () => {
    const provider = new DeterministicProvider({ seed: 7 });
    const a = await provider.complete({ prompt: 'x' });
    const b = await provider.complete({ prompt: 'x' });
    expect(a.text).toBe(b.text);
  });

  it('reports deterministic usage counts', async () => {
    const provider = new DeterministicProvider({ sentences: 2 });
    const completion = await provider.complete({ prompt: 'abcd' });
    expect(completion.usage.promptTokens).toBe(1);
    expect(completion.usage.completionTokens).toBe(completion.text.split(/\s+/).length);
    expect(completion.usage.totalTokens).toBe(
      completion.usage.promptTokens + completion.usage.completionTokens,
    );
  });

  it('computes requestHash as sha256 of seed and prompt', async () => {
    const provider = new DeterministicProvider();
    const completion = await provider.complete({ prompt: 'hello', options: { seed: 3 } });
    expect(completion.requestHash).toBe(sha256Hex('3\nhello'));
  });

  it('is fully local and deterministic in shape', async () => {
    const provider = new DeterministicProvider();
    const completion = await provider.complete({ prompt: 'x' });
    expect(completion.provider).toBe('deterministic');
    expect(completion.finishReason).toBe('completed');
    expect(completion.text.length).toBeGreaterThan(0);
  });

  it('honours maxTokens bounds on sentence count', async () => {
    const provider = new DeterministicProvider();
    const small = await provider.complete({ prompt: 'x', options: { maxTokens: 5 } });
    const large = await provider.complete({ prompt: 'x', options: { maxTokens: 1000 } });
    expect(small.text.split(/\s+/).length).toBeLessThan(
      large.text.split(/\s+/).length,
    );
  });
});
