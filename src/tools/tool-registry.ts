import type { JsonValue } from '../core/json.js';
import type { Schema, SchemaValidation, Tool, ToolContext } from './tool.js';
import { validateSchema } from './tool.js';
import { DuplicateToolError, ToolExecutionError, ToolNotFoundError, ToolValidationError } from '../core/errors.js';

/**
 * Registry of named tools. Enforces unique names, resolves tools by name,
 * validates inputs against each tool's declared schema, and normalizes
 * tool failures into domain errors.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Validate arguments against a tool's input schema without executing it. */
  validate(name: string, args: unknown): SchemaValidation {
    const tool = this.get(name);
    return validateSchema(tool.inputSchema as Schema, args);
  }

  /** Look up, validate, and execute a tool. Throws domain errors on failure. */
  async execute(name: string, args: unknown, context: ToolContext): Promise<JsonValue> {
    const tool = this.get(name);
    const validation = validateSchema(tool.inputSchema as Schema, args);
    if (!validation.ok) {
      throw new ToolValidationError(name, validation.issues);
    }
    try {
      return await tool.execute(args as JsonValue, context);
    } catch (error) {
      if (error instanceof ToolExecutionError || error instanceof ToolValidationError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new ToolExecutionError(name, error);
    }
  }
}
