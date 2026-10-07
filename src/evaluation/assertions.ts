/**
 * Evaluation assertions (Milestone 4).
 *
 * Reusable assertion functions for evaluating agent workflow
 * outputs. Each assertion returns a pass/fail result with a
 * human-readable message.
 */

/** An assertion result. */
export interface AssertionResult {
  readonly passed: boolean;
  readonly message: string;
}

/** Assert that a value is defined (not undefined/null). */
export function assertDefined<T>(name: string, value: T | undefined | null): AssertionResult {
  const passed = value !== undefined && value !== null;
  return {
    passed,
    message: passed ? `${name} is defined` : `${name} is undefined or null`,
  };
}

/** Assert that a string is non-empty. */
export function assertNonEmpty(name: string, value: string): AssertionResult {
  const passed = value.length > 0;
  return {
    passed,
    message: passed ? `${name} is non-empty` : `${name} is empty`,
  };
}

/** Assert that a number is within a range. */
export function assertInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): AssertionResult {
  const passed = value >= min && value <= max;
  return {
    passed,
    message: passed
      ? `${name} is in range [${min}, ${max}]`
      : `${name} = ${value} is outside range [${min}, ${max}]`,
  };
}

/** Assert that an array has a minimum length. */
export function assertMinLength<T>(name: string, value: readonly T[], min: number): AssertionResult {
  const passed = value.length >= min;
  return {
    passed,
    message: passed
      ? `${name} has ${value.length} items (min: ${min})`
      : `${name} has ${value.length} items, expected at least ${min}`,
  };
}

/** Assert that a value equals an expected value. */
export function assertEquals<T>(name: string, actual: T, expected: T): AssertionResult {
  const passed = actual === expected;
  return {
    passed,
    message: passed
      ? `${name} equals expected value`
      : `${name} = ${actual}, expected ${expected}`,
  };
}

/** Assert that a condition is true. */
export function assertTrue(name: string, condition: boolean): AssertionResult {
  return {
    passed: condition,
    message: condition ? `${name} is true` : `${name} is false`,
  };
}

/** Assert that a string contains a substring. */
export function assertContains(name: string, haystack: string, needle: string): AssertionResult {
  const passed = haystack.includes(needle);
  return {
    passed,
    message: passed
      ? `${name} contains "${needle}"`
      : `${name} does not contain "${needle}"`,
  };
}

/** Assert that a value is one of an allowed set. */
export function assertOneOf<T>(name: string, value: T, allowed: readonly T[]): AssertionResult {
  const passed = allowed.includes(value);
  return {
    passed,
    message: passed
      ? `${name} is one of allowed values`
      : `${name} = ${value}, expected one of [${allowed.join(', ')}]`,
  };
}

/** Combine multiple assertions into a single result. */
export function combineAssertions(results: readonly AssertionResult[]): AssertionResult {
  const passed = results.every((r) => r.passed);
  const messages = results.map((r) => (r.passed ? `  PASS: ${r.message}` : `  FAIL: ${r.message}`));
  return {
    passed,
    message: messages.join('\n'),
  };
}
