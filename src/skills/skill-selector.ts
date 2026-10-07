import type { Skill } from './skill.js';

/**
 * Skill selector (Milestone 3).
 *
 * Deterministically selects the most relevant skills for a
 * given context (objective, task description, available tags).
 * Selection is based on tag matching and name/description
 * keyword overlap — no ML, no embeddings, no external services.
 *
 * The same set of skills and query always produces the same
 * selection.
 */

/** A skill with its relevance score. */
export interface ScoredSkill {
  readonly skill: Skill;
  readonly score: number;
}

/**
 * Select the top-k most relevant skills for a query.
 *
 * Scoring:
 * - +3 for each tag that matches a query tag
 * - +2 for each query keyword found in the skill name
 * - +1 for each query keyword found in the skill description
 *
 * Ties are broken by skill name (ascending) for determinism.
 */
export function selectSkills(
  skills: readonly Skill[],
  query: string,
  options: { readonly topK?: number; readonly queryTags?: readonly string[] } = {},
): ScoredSkill[] {
  const topK = options.topK ?? 3;
  const queryTags = new Set((options.queryTags ?? []).map((t) => t.toLowerCase()));
  const keywords = tokenize(query);

  const scored: ScoredSkill[] = skills.map((skill) => {
    let score = 0;

    // Tag matching.
    for (const tag of skill.metadata.tags) {
      if (queryTags.has(tag.toLowerCase())) {
        score += 3;
      }
    }

    // Keyword matching in name and description.
    const nameLower = skill.metadata.name.toLowerCase();
    const descLower = skill.metadata.description.toLowerCase();
    for (const keyword of keywords) {
      if (nameLower.includes(keyword)) score += 2;
      if (descLower.includes(keyword)) score += 1;
    }

    return { skill, score };
  });

  // Sort by score descending, then name ascending for determinism.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.metadata.name.localeCompare(b.skill.metadata.name);
  });

  // Filter out zero-score skills, then take top-k.
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

/** Tokenize a query into lowercase keywords. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}
