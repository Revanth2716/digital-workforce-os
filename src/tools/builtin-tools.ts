import type { Tool, ToolContext } from './tool.js';
import { ToolExecutionError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';

/**
 * Deterministic arithmetic tool. Demonstrates the tool contract: declared
 * schema, pure function, no I/O, no external services.
 */
export const calculatorSchema = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
    a: { type: 'number' },
    b: { type: 'number' },
  },
  required: ['operation', 'a', 'b'],
} as const;

export class CalculatorTool implements Tool {
  readonly name = 'calculator';
  readonly description = 'Deterministic arithmetic: add, subtract, multiply, divide';
  readonly inputSchema = calculatorSchema;
  readonly readOnly = true;

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const { operation, a, b } = args as { operation: string; a: number; b: number };
    switch (operation) {
      case 'add':
        return a + b;
      case 'subtract':
        return a - b;
      case 'multiply':
        return a * b;
      case 'divide': {
        if (b === 0) {
          throw new ToolExecutionError(this.name, new Error('division by zero'));
        }
        return a / b;
      }
      default:
        throw new ToolExecutionError(this.name, new Error(`unknown operation: ${operation}`));
    }
  }
}

/** Deterministic text analysis tool. */
export const wordCountSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
} as const;

export interface WordCountResult {
  readonly words: number;
  readonly characters: number;
  readonly lines: number;
}

export class WordCountTool implements Tool {
  readonly name = 'word_count';
  readonly description = 'Counts words, characters and lines in the given text';
  readonly inputSchema = wordCountSchema;
  readonly readOnly = true;

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const { text } = args as { text: string };
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    return {
      words,
      characters: text.length,
      lines: text.length === 0 ? 0 : text.split('\n').length,
    } satisfies WordCountResult;
  }
}
