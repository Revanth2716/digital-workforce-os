import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import {
  CalculatorTool,
  WordCountTool,
} from '../src/tools/builtin-tools.js';
import type { Schema, Tool, ToolContext } from '../src/tools/tool.js';
import { TypedEventBus } from '../src/events/event-bus.js';
import { EvidenceLog } from '../src/events/evidence.js';
import {
  DeterministicIdGenerator,
  FakeClock,
} from '../src/core/types.js';
import type { RunId, TaskId } from '../src/core/types.js';
import type { JsonValue } from '../src/core/json.js';
import { ToolCaller } from '../src/agents/tool-caller.js';
import type { ToolCallRequest } from '../src/agents/schemas.js';

function makeHarness() {
  const bus = new TypedEventBus();
  const ids = new DeterministicIdGenerator('test');
  const clock = new FakeClock();
  const tools = new ToolRegistry();
  tools.register(new CalculatorTool());
  tools.register(new WordCountTool());
  const evidence = new EvidenceLog(bus, ids, clock);
  return { bus, ids, clock, tools, evidence };
}

function makeContext(
  harness: ReturnType<typeof makeHarness>,
): {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly clock: FakeClock;
  readonly evidence: EvidenceLog;
} {
  return {
    runId: 'run-tool-test' as RunId,
    taskId: 'task-tool-test' as TaskId,
    clock: harness.clock,
    evidence: harness.evidence,
  };
}

describe('ToolCaller — structured tool-calling flow', () => {
  it('executes a valid tool call and returns a structured result', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);
    const request: ToolCallRequest = {
      id: 'call-1',
      tool: 'calculator',
      arguments: { operation: 'add', a: 2, b: 3 },
    };

    const result = await caller.call(request, context);

    expect(result.ok).toBe(true);
    expect(result.id).toBe('call-1');
    expect(result.tool).toBe('calculator');
    expect(result.output).toBe(5);
    expect(result.durationMs).toBe(0); // FakeClock never moves
  });

  it('validates input before execution and reports violations', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    const result = await caller.call(
      { id: 'call-2', tool: 'calculator', arguments: { a: 1, b: 2 } },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('operation');
    expect(result.error).toContain('required');
  });

  it('reports unknown tools as failed results', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    const result = await caller.call(
      { id: 'call-3', tool: 'nonexistent', arguments: {} },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('reports tool execution failures as failed results', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    const result = await caller.call(
      {
        id: 'call-4',
        tool: 'calculator',
        arguments: { operation: 'divide', a: 1, b: 0 },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('division by zero');
  });

  it('executes multiple calls sequentially through callAll', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    const results = await caller.callAll(
      [
        { id: 'c1', tool: 'calculator', arguments: { operation: 'multiply', a: 6, b: 7 } },
        { id: 'c2', tool: 'word_count', arguments: { text: 'one two three' } },
        { id: 'c3', tool: 'calculator', arguments: { operation: 'subtract', a: 10, b: 4 } },
      ],
      context,
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.output).toBe(42);
    expect((results[1]?.output as { words: number }).words).toBe(3);
    expect(results[2]?.output).toBe(6);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('records tool.call and tool.result evidence for every invocation', async () => {
    const harness = makeHarness();
    const recorded: string[] = [];
    harness.bus.on('evidence.recorded', (event) => {
      recorded.push((event.payload as { kind: string }).kind);
    });
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    await caller.call(
      { id: 'call-9', tool: 'calculator', arguments: { operation: 'add', a: 1, b: 1 } },
      context,
    );

    expect(recorded).toEqual(['tool.call', 'tool.result']);
  });

  it('records the call arguments and result in evidence', async () => {
    const harness = makeHarness();
    const payloads: Array<Record<string, unknown>> = [];
    harness.bus.on('evidence.recorded', (event) => {
      payloads.push(event.payload as Record<string, unknown>);
    });
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    await caller.call(
      { id: 'call-10', tool: 'word_count', arguments: { text: 'hello world' } },
      context,
    );

    const callEvidence = payloads[0];
    const resultEvidence = payloads[1];
    expect(callEvidence).toBeDefined();
    expect(resultEvidence).toBeDefined();
    expect(callEvidence?.['kind']).toBe('tool.call');
    const callData = callEvidence?.['data'] as Record<string, unknown>;
    expect(callData['callId']).toBe('call-10');
    expect(callData['tool']).toBe('word_count');
    expect(callData['arguments']).toEqual({ text: 'hello world' });

    expect(resultEvidence?.['kind']).toBe('tool.result');
    const resultData = resultEvidence?.['data'] as Record<string, unknown>;
    expect(resultData['ok']).toBe(true);
    expect((resultData['output'] as { words: number }).words).toBe(2);
  });

  it('records failed results with their error in evidence', async () => {
    const harness = makeHarness();
    const payloads: Array<Record<string, unknown>> = [];
    harness.bus.on('evidence.recorded', (event) => {
      payloads.push(event.payload as Record<string, unknown>);
    });
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    await caller.call(
      { id: 'call-11', tool: 'calculator', arguments: {} },
      context,
    );

    const resultEvidence = payloads[1];
    expect(resultEvidence).toBeDefined();
    const resultData = resultEvidence?.['data'] as Record<string, unknown>;
    expect(resultData['ok']).toBe(false);
    expect(typeof resultData['error']).toBe('string');
  });

  it('enforces read-only mode for read-only agents', async () => {
    const harness = makeHarness();
    // A side-effecting tool: NOT marked read-only.
    class PublishTool implements Tool {
      readonly name = 'publish';
      readonly description = 'publishes (has side effects)';
      readonly inputSchema: Schema = { type: 'object', properties: {} };
      readonly readOnly = false;
      async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
        return { published: true };
      }
    }
    harness.tools.register(new PublishTool());
    const caller = new ToolCaller(harness.tools, { readOnlyOnly: true });
    const context = makeContext(harness);

    // Read-only tools pass...
    const allowed = await caller.call(
      { id: 'c1', tool: 'word_count', arguments: { text: 'x' } },
      context,
    );
    expect(allowed.ok).toBe(true);

    // ...side-effecting tools are refused.
    const refused = await caller.call(
      { id: 'c2', tool: 'publish', arguments: {} },
      context,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('read-only');
  });

  it('treats unmarked tools as not guaranteed read-only', async () => {
    const harness = makeHarness();
    // A tool without an explicit readOnly flag.
    class UnmarkedTool implements Tool {
      readonly name = 'unmarked';
      readonly description = 'unmarked';
      readonly inputSchema: Schema = { type: 'object', properties: {} };
      async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
        return null;
      }
    }
    harness.tools.register(new UnmarkedTool());
    const caller = new ToolCaller(harness.tools, { readOnlyOnly: true });
    const context = makeContext(harness);

    const result = await caller.call(
      { id: 'c1', tool: 'unmarked', arguments: {} },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('honours the abort signal between calls', async () => {
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const controller = new AbortController();
    const context = {
      ...makeContext(harness),
      signal: controller.signal,
    };
    controller.abort();

    await expect(
      caller.callAll(
        [{ id: 'c1', tool: 'calculator', arguments: { operation: 'add', a: 1, b: 1 } }],
        context,
      ),
    ).rejects.toThrow();
  });

  it('uses the injected clock for duration measurement', async () => {
    const harness = makeHarness();
    // A tool that takes time: advances the shared clock
    // while it executes.
    class SlowTool implements Tool {
      readonly name = 'slow';
      readonly description = 'advances the clock';
      readonly inputSchema: Schema = { type: 'object', properties: {} };
      readonly readOnly = true;
      async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
        harness.clock.advance(50);
        return null;
      }
    }
    harness.tools.register(new SlowTool());
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);

    const result = await caller.call(
      { id: 'c1', tool: 'slow', arguments: {} },
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.durationMs).toBe(50);
  });

  it('runs builtin tools through the same flow the agents use', async () => {
    // End-to-end: the exact flow Agent -> ToolCallRequest ->
    // ToolRegistry -> validation -> execution -> ToolCallResult.
    const harness = makeHarness();
    const caller = new ToolCaller(harness.tools);
    const context = makeContext(harness);
    const toolContext: ToolContext = { clock: harness.clock };

    // Direct registry execution for cross-checking.
    const direct = await harness.tools.execute(
      'calculator',
      { operation: 'multiply', a: 6, b: 7 },
      toolContext,
    );

    const viaCaller = await caller.call(
      {
        id: 'c1',
        tool: 'calculator',
        arguments: { operation: 'multiply', a: 6, b: 7 },
      },
      context,
    );

    expect(viaCaller.ok).toBe(true);
    expect(viaCaller.output).toBe(direct);
    expect(viaCaller.output).toBe(42);
  });
});
