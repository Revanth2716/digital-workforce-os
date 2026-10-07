import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../core/json.js';
import {
  ProviderError,
  StructuredOutputError,
  TimeoutError,
} from '../core/errors.js';
import type {
  Completion,
  CompletionRequest,
  CompletionUsage,
} from './provider.js';
import type {
  LLMProvider,
  ModelInfo,
  StructuredCompletion,
  StructuredCompletionRequest,
} from './llm-provider.js';

export interface OpenAICompatibleProviderOptions {
  /**
   * Base URL of the OpenAI-compatible API (e.g.
   * `https://api.openai.com/v1`). Falls back to the
   * `OPENAI_BASE_URL` environment variable. Required —
   * constructing the provider without one fails fast,
   * because an unconfigured provider must never silently
   * hit the network.
   */
  readonly baseURL?: string;
  /**
   * API key. Falls back to `OPENAI_API_KEY`. Optional:
   * some OpenAI-compatible endpoints (local gateways,
   * proxies) require no key. Never hard-coded.
   */
  readonly apiKey?: string;
  /** Model name. Defaults to `gpt-4o-mini`. */
  readonly model?: string;
  /** Per-request wall-clock budget. Defaults to 30_000ms. */
  readonly timeoutMs?: number;
  /**
   * Fetch implementation. Injectable so tests can run the
   * provider with zero network access.
   */
  readonly fetchImpl?: typeof fetch;
  /** Extra headers merged into every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

interface ChatCompletionMessage {
  readonly role: 'user';
  readonly content: string;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly model?: string;
}

/**
 * Optional OpenAI-compatible provider (Milestone 2).
 *
 * Talks to any OpenAI-compatible `/chat/completions`
 * endpoint, including the structured-outputs
 * (`response_format: json_schema`) API. It is entirely
 * opt-in: the composition only creates it when explicitly
 * configured with a base URL, and it throws a clear
 * `ProviderError` at construction when unconfigured. The
 * deterministic provider remains the default, so the
 * project runs for free with zero network access.
 *
 * Credentials are never hard-coded: the API key comes
 * from options or the `OPENAI_API_KEY` environment
 * variable, and some endpoints need none at all.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  readonly model: ModelInfo;

  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    const baseURL = options.baseURL ?? process.env['OPENAI_BASE_URL'];
    if (baseURL === undefined || baseURL.trim() === '') {
      throw new ProviderError(
        'OpenAICompatibleProvider requires a baseURL (option or OPENAI_BASE_URL env var). ' +
          'The deterministic provider remains the default — no external service is required to run this project.',
      );
    }
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this.modelName = options.model ?? 'gpt-4o-mini';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
    this.model = {
      provider: this.name,
      name: this.modelName,
      capabilities: ['text', 'structured-output', 'tool-calling'],
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const chat = await this.chat(request.prompt, request.options, undefined);
    return {
      text: chat.text,
      provider: this.name,
      finishReason: chat.finishReason === 'length' ? 'max_tokens' : 'completed',
      usage: chat.usage,
      requestHash: sha256Hex(`${this.modelName}\n${request.prompt}`),
    };
  }

  async generateStructured<T>(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletion<T>> {
    const chat = await this.chat(request.prompt, request.options, request.schema);
    let value: unknown;
    try {
      value = JSON.parse(chat.text);
    } catch (error) {
      throw new StructuredOutputError(
        `OpenAI-compatible model returned non-JSON output for intent '${request.intent ?? 'default'}'`,
        { cause: error },
      );
    }
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      throw new StructuredOutputError(
        `OpenAI-compatible model output failed schema validation for intent '${request.intent ?? 'default'}'`,
        { issues },
      );
    }
    return {
      value: parsed.data as T,
      provider: this.name,
      model: chat.model,
      finishReason: chat.finishReason === 'length' ? 'max_tokens' : 'completed',
      usage: chat.usage,
      requestHash: canonicalJson({
        prompt: request.prompt,
        intent: request.intent ?? 'default',
        model: this.modelName,
      }),
      raw: chat.text,
    };
  }

  /**
   * Perform a chat-completion request with timeout and
   * error normalisation. When `schema` is supplied the
   * structured-outputs response format is requested.
   */
  private async chat(
    prompt: string,
    options: StructuredCompletionRequest['options'],
    schema: z.ZodType | undefined,
  ): Promise<{
    readonly text: string;
    readonly usage: CompletionUsage;
    readonly finishReason: string;
    readonly model: string;
  }> {
    const url = `${this.baseURL}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey !== undefined && this.apiKey !== '') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: [{ role: 'user', content: prompt }] satisfies ChatCompletionMessage[],
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 1024,
    };
    if (schema !== undefined) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          strict: true,
          schema: z.toJSONSchema(schema),
        },
      };
    }

    const controller = new AbortController();
    const request = this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let response: Response;
    try {
      response = await this.raceTimeout(request, this.timeoutMs, controller);
    } catch (error) {
      if (error instanceof TimeoutError || error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `OpenAI-compatible request to ${this.baseURL} failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new ProviderError(
        `OpenAI-compatible endpoint returned HTTP ${response.status}: ${truncate(bodyText, 200)}`,
      );
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      throw new ProviderError(
        'OpenAI-compatible endpoint returned invalid JSON',
        { cause: error },
      );
    }

    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (text === '') {
      throw new ProviderError('OpenAI-compatible endpoint returned an empty completion');
    }
    const usage = payload.usage;
    return {
      text,
      finishReason: choice?.finish_reason ?? 'stop',
      model: payload.model ?? this.modelName,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    };
  }

  /**
   * Race a request against a wall-clock budget. The abort
   * signal gives real fetches a chance to cancel; the race
   * makes the timeout deterministic even for fetch
   * implementations that ignore the signal.
   */
  private async raceTimeout(
    request: Promise<Response>,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
