import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillMetadata } from './skill.js';

/**
 * Skill loader (Milestone 3).
 *
 * Discovers, parses, and loads version-controlled Markdown
 * skills from a directory. Each skill is a subdirectory
 * containing a `SKILL.md` file with YAML front matter metadata
 * and Markdown instruction content.
 *
 * The loader is deterministic: the same directory always
 * produces the same set of skills in the same order.
 */

/** Parse YAML front matter from a SKILL.md file. */
export function parseSkillFrontMatter(content: string): {
  readonly metadata: SkillMetadata;
  readonly body: string;
} {
  const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontMatterMatch === null) {
    throw new Error('Skill file missing YAML front matter');
  }

  const yamlBlock = frontMatterMatch[1]!;
  const body = content.slice(frontMatterMatch[0].length);

  // Minimal YAML parser for simple key: value and list formats.
  const metadata: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  const listItems: string[] = [];

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // List item (e.g. "  - analysis" or "- analysis").
    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch !== null && currentKey !== null) {
      listItems.push(listMatch[1]!.trim());
      metadata[currentKey] = [...listItems];
      continue;
    }

    // Key: value pair.
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch !== null) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();
      currentKey = key;
      if (value === '') {
        // Start of a block-style list.
        metadata[key] = [];
        listItems.length = 0;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Flow-style array: [item1, item2, ...].
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          metadata[key] = [];
        } else {
          metadata[key] = inner.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
        }
      } else {
        metadata[key] = value;
      }
    }
  }

  const name = metadata['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Skill front matter missing required "name" field');
  }

  const description = metadata['description'];
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('Skill front matter missing required "description" field');
  }

  const version = metadata['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Skill front matter missing required "version" field');
  }

  const tags = metadata['tags'];
  const tagList = Array.isArray(tags) ? tags : [];

  return {
    metadata: {
      name,
      description,
      version,
      tags: tagList,
    },
    body: body.trim(),
  };
}

/**
 * Discover and load all skills from a directory.
 *
 * Each subdirectory containing a `SKILL.md` file is loaded as
 * a skill. Returns skills sorted by name for deterministic
 * ordering.
 */
export function loadSkills(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return []; // No skills directory — return empty.
  }

  for (const entry of entries.sort()) {
    const entryPath = join(skillsDir, entry);
    const skillFilePath = join(entryPath, 'SKILL.md');

    try {
      if (!statSync(entryPath).isDirectory()) continue;
      if (!statSync(skillFilePath).isFile()) continue;
    } catch {
      continue; // Skip entries without a readable SKILL.md.
    }

    const content = readFileSync(skillFilePath, 'utf-8');
    const { metadata, body } = parseSkillFrontMatter(content);

    skills.push({
      id: entry,
      metadata,
      instructions: body,
      filePath: skillFilePath,
    });
  }

  return skills;
}

/** Load a single skill from a SKILL.md file path. */
export function loadSkill(skillId: string, filePath: string): Skill {
  const content = readFileSync(filePath, 'utf-8');
  const { metadata, body } = parseSkillFrontMatter(content);
  return {
    id: skillId,
    metadata,
    instructions: body,
    filePath,
  };
}
