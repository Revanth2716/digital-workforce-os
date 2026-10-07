import type { Agent } from './agent.js';
import { AgentNotFoundError, DuplicateAgentError } from '../core/errors.js';

/** Registry of named agents available to the orchestrator. */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.name)) {
      throw new DuplicateAgentError(agent.name);
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): Agent {
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new AgentNotFoundError(name);
    }
    return agent;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }
}
