import { describe, expect, it } from 'vitest';
import { TaskGraph, createTask } from '../src/graph/task-graph.js';
import {
  CycleError,
  DuplicateTaskError,
  TaskNotFoundError,
  ValidationError,
} from '../src/core/errors.js';
import { DeterministicIdGenerator } from '../src/core/types.js';
import type { TaskId } from '../src/core/types.js';

function setup() {
  const ids = new DeterministicIdGenerator();
  const graph = new TaskGraph();
  return { ids, graph };
}

describe('TaskGraph', () => {
  it('adds and retrieves tasks in insertion order', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'alpha', 'deterministic');
    const b = createTask(ids.taskId(), 'beta', 'deterministic');
    graph.addTask(a);
    graph.addTask(b);
    expect(graph.size).toBe(2);
    expect(graph.hasTask(a.id)).toBe(true);
    expect(graph.getTask(a.id)).toBe(a);
    expect(graph.tasks.map((task) => task.name)).toEqual(['alpha', 'beta']);
  });

  it('rejects duplicate task ids', () => {
    const { ids, graph } = setup();
    graph.addTask(createTask(ids.taskId(), 'alpha', 'deterministic'));
    const duplicate = createTask('task-000001' as TaskId, 'again', 'deterministic');
    expect(() => graph.addTask(duplicate)).toThrow(DuplicateTaskError);
  });

  it('rejects empty names and agents', () => {
    const { ids, graph } = setup();
    expect(() =>
      graph.addTask(createTask(ids.taskId(), '  ', 'deterministic')),
    ).toThrow(ValidationError);
    expect(() =>
      graph.addTask(createTask(ids.taskId(), 'x', '')),
    ).toThrow(ValidationError);
  });

  it('rejects self-dependency and duplicate dependencies', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'alpha', 'deterministic');
    expect(() =>
      graph.addTask(createTask(ids.taskId(), 'self', 'deterministic', { dependsOn: [a.id, a.id] })),
    ).toThrow(ValidationError);
    expect(() =>
      graph.addTask(createTask(a.id, 'loop', 'deterministic', { dependsOn: [a.id] })),
    ).toThrow(ValidationError);
  });

  it('rejects negative retries and non-positive timeouts', () => {
    const { ids, graph } = setup();
    expect(() =>
      graph.addTask(createTask(ids.taskId(), 'x', 'deterministic', { retries: -1 })),
    ).toThrow(ValidationError);
    expect(() =>
      graph.addTask(createTask(ids.taskId(), 'x', 'deterministic', { timeoutMs: 0 })),
    ).toThrow(ValidationError);
  });

  it('rejects unknown dependencies on validate', () => {
    const { ids, graph } = setup();
    graph.addTask(
      createTask(ids.taskId(), 'alpha', 'deterministic', {
        dependsOn: ['task-999999' as TaskId],
      }),
    );
    expect(() => graph.validate()).toThrow(ValidationError);
  });

  it('detects cycles and reports the cycle path', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'a', 'deterministic');
    const b = createTask(ids.taskId(), 'b', 'deterministic', { dependsOn: [a.id] });
    const c = createTask(ids.taskId(), 'c', 'deterministic', { dependsOn: [b.id] });
    const aWithCycle = { ...a, dependsOn: [c.id] as readonly TaskId[] };
    graph.addTask(aWithCycle);
    graph.addTask(b);
    graph.addTask(c);
    expect(() => graph.validate()).toThrow(CycleError);
    try {
      graph.validate();
      expect.unreachable('validate should throw');
    } catch (error) {
      const cycleError = error as CycleError;
      expect(cycleError.cycle.length).toBeGreaterThan(0);
      expect(cycleError.cycle[0]).toBe(cycleError.cycle[cycleError.cycle.length - 1]);
    }
  });

  it('produces a deterministic topological order (insertion-order tiebreak)', () => {
    const { ids, graph } = setup();
    graph.addTask(createTask(ids.taskId(), 'zulu', 'deterministic'));
    graph.addTask(createTask(ids.taskId(), 'alpha', 'deterministic'));
    graph.addTask(createTask(ids.taskId(), 'mike', 'deterministic'));
    const order = graph.topologicalOrder().map((task) => task.name);
    expect(order).toEqual(['zulu', 'alpha', 'mike']);
    // Deterministic across repeated calls.
    expect(graph.topologicalOrder().map((task) => task.name)).toEqual(order);
  });

  it('orders a diamond dependency deterministically', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'a', 'deterministic');
    const b = createTask(ids.taskId(), 'b', 'deterministic', { dependsOn: [a.id] });
    const c = createTask(ids.taskId(), 'c', 'deterministic', { dependsOn: [a.id] });
    const d = createTask(ids.taskId(), 'd', 'deterministic', {
      dependsOn: [b.id, c.id],
    });
    graph.addTask(a);
    graph.addTask(b);
    graph.addTask(c);
    graph.addTask(d);
    expect(graph.topologicalOrder().map((task) => task.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(graph.levels().map((level) => level.map((task) => task.name))).toEqual([
      ['a'],
      ['b', 'c'],
      ['d'],
    ]);
  });

  it('throws on topologicalOrder for cyclic graphs', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'a', 'deterministic');
    const b = createTask(ids.taskId(), 'b', 'deterministic', { dependsOn: [a.id] });
    graph.addTask({ ...a, dependsOn: [b.id] as readonly TaskId[] });
    graph.addTask(b);
    expect(() => graph.topologicalOrder()).toThrow(CycleError);  });

  it('answers dependency queries', () => {
    const { ids, graph } = setup();
    const a = createTask(ids.taskId(), 'a', 'deterministic');
    const b = createTask(ids.taskId(), 'b', 'deterministic', { dependsOn: [a.id] });
    const c = createTask(ids.taskId(), 'c', 'deterministic', { dependsOn: [a.id] });
    graph.addTask(a);
    graph.addTask(b);
    graph.addTask(c);
    expect(graph.dependenciesOf(b.id).map((task) => task.name)).toEqual(['a']);
    expect(graph.dependentsOf(a.id).map((task) => task.name)).toEqual(['b', 'c']);
    expect(() => graph.getTask('task-999999' as TaskId)).toThrow(TaskNotFoundError);
  });
});
