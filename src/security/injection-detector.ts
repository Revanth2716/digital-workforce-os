/**
 * Prompt-injection detector (Milestone 4).
 *
 * Deterministic first-line defense against prompt injection
 * attacks. Treats retrieved documents, repository files,
 * tool output, and external text as untrusted DATA.
 *
 * Detects common instruction-injection patterns:
 * - Attempts to override system/developer instructions
 * - Attempts to reveal secrets
 * - Attempts to bypass safety rules
 * - Instructions to execute commands
 * - Instructions pretending to be trusted system messages
 *
 * IMPORTANT: This is a deterministic defense layer, NOT a
 * complete security solution. It catches common patterns but
 * cannot guarantee protection against all attacks.
 */

/** The safety classification of a text. */
export type SafetyLevel = 'SAFE' | 'SUSPICIOUS' | 'BLOCKED';

/** A detection result with reason and source. */
export interface DetectionResult {
  readonly level: SafetyLevel;
  readonly reason: string;
  readonly source: string;
  readonly patterns: readonly string[];
}

/** A detected pattern. */
export interface DetectedPattern {
  readonly pattern: string;
  readonly description: string;
}

// ---- Injection patterns -----------------------------------------------------

const INJECTION_PATTERNS: readonly DetectedPattern[] = [
  {
    pattern: 'ignore (all |any )?(previous|above|prior) instructions',
    description: 'attempts to override previous instructions',
  },
  {
    pattern: 'disregard (all |any )?(previous|above|prior)',
    description: 'attempts to disregard previous instructions',
  },
  {
    pattern: 'forget (all |any )?(previous|above|prior)',
    description: 'attempts to forget previous instructions',
  },
  {
    pattern: 'you are now',
    description: 'attempts to redefine the agent role',
  },
  {
    pattern: 'new instructions?:',
    description: 'attempts to provide new instructions',
  },
  {
    pattern: 'system prompt',
    description: 'references system prompt',
  },
  {
    pattern: 'developer (message|instructions)',
    description: 'references developer instructions',
  },
  {
    pattern: 'reveal (your |the )?(secret|api key|password|token|credential)',
    description: 'attempts to reveal secrets',
  },
  {
    pattern: 'show (me )?(your |the )?(secret|api key|password|token|credential)',
    description: 'attempts to show secrets',
  },
  {
    pattern: 'bypass (the |any |all )?(safety|security|policy|guardrail)',
    description: 'attempts to bypass safety rules',
  },
  {
    pattern: 'disable (the |any |all )?(safety|security|policy|guardrail)',
    description: 'attempts to disable safety rules',
  },
  {
    pattern: 'execute (this |the )?command\\b',
    description: 'instructions to execute commands',
  },
  {
    pattern: 'run (this |the )?command\\b',
    description: 'instructions to run commands',
  },
  {
    pattern: 'sudo ',
    description: 'attempts to use sudo',
  },
  {
    pattern: 'rm -rf',
    description: 'attempts to delete files recursively',
  },
  {
    pattern: 'as (a |an )?(system|admin|root|administrator)',
    description: 'pretends to be a trusted system message',
  },
  {
    pattern: '\\[system\\]',
    description: 'pretends to be a system message',
  },
  {
    pattern: '\\[assistant\\]',
    description: 'pretends to be an assistant message',
  },
  {
    pattern: 'human:',
    description: 'pretends to be a human message',
  },
  {
    pattern: 'assistant:',
    description: 'pretends to be an assistant message',
  },
  {
    pattern: 'override (safety|security|policy|guardrail)',
    description: 'attempts to override safety rules',
  },
  {
    pattern: 'without (restrictions|limits|boundaries)',
    description: 'attempts to remove restrictions',
  },
];

/**
 * Analyze text for prompt-injection patterns.
 * Returns a structured result with safety level, reason,
 * source, and detected patterns.
 */
export function analyzeText(text: string, source: string): DetectionResult {
  const lowerText = text.toLowerCase();
  const detected: DetectedPattern[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.pattern, 'i');
    if (regex.test(lowerText)) {
      detected.push(pattern);
    }
  }

  if (detected.length === 0) {
    return {
      level: 'SAFE',
      reason: 'no injection patterns detected',
      source,
      patterns: [],
    };
  }

  // Determine severity based on the number and type of patterns.
  // Critical patterns are those that pose an immediate security risk.
  const criticalPatterns = detected.filter(
    (p) =>
      p.description.includes('sudo') ||
      p.description.includes('rm -rf') ||
      p.description.includes('system message') ||
      p.description.includes('trusted system'),
  );

  // High-risk patterns are suspicious but not immediately dangerous.
  const highRiskPatterns = detected.filter(
    (p) =>
      p.description.includes('secrets') ||
      p.description.includes('bypass') ||
      p.description.includes('disable') ||
      p.description.includes('execute'),
  );

  // BLOCKED if there are multiple critical patterns, or a combination
  // of critical and other patterns, or many patterns overall.
  if (criticalPatterns.length >= 2 || (criticalPatterns.length >= 1 && detected.length >= 2) || detected.length >= 3) {
    return {
      level: 'BLOCKED',
      reason: `blocked: ${detected.length} injection pattern(s) detected: ${detected.map((p) => p.description).join('; ')}`,
      source,
      patterns: detected.map((p) => p.description),
    };
  }

  // SUSPICIOUS if there are high-risk patterns or multiple patterns.
  if (highRiskPatterns.length > 0 || detected.length >= 2) {
    return {
      level: 'SUSPICIOUS',
      reason: `suspicious: ${detected.length} pattern(s) detected: ${detected.map((p) => p.description).join('; ')}`,
      source,
      patterns: detected.map((p) => p.description),
    };
  }

  return {
    level: 'SUSPICIOUS',
    reason: `suspicious: ${detected.length} pattern(s) detected: ${detected.map((p) => p.description).join('; ')}`,
    source,
    patterns: detected.map((p) => p.description),
  };
}

/**
 * Analyze multiple text sources and return the most severe
 * result. This is useful when evaluating tool output that
 * may contain multiple untrusted sources.
 */
export function analyzeMultiple(
  sources: readonly { readonly text: string; readonly source: string }[],
): DetectionResult {
  let mostSevere: DetectionResult = {
    level: 'SAFE',
    reason: 'no injection patterns detected',
    source: 'aggregate',
    patterns: [],
  };

  for (const { text, source } of sources) {
    const result = analyzeText(text, source);
    if (result.level === 'BLOCKED') {
      return result;
    }
    if (result.level === 'SUSPICIOUS' && mostSevere.level === 'SAFE') {
      mostSevere = result;
    }
  }

  return mostSevere;
}
