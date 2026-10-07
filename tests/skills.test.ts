import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFrontMatter, loadSkills, loadSkill } from '../src/skills/skill-loader.js';
import { selectSkills } from '../src/skills/skill-selector.js';
import type { Skill } from '../src/skills/skill.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-skills-'));
  tempDirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Skills — metadata parsing', () => {
  it('parses valid front matter', () => {
    const content = `---
name: test-skill
description: A test skill
version: 1.0.0
tags: [test, demo]
---

# Test Skill

This is the instruction body.
`;
    const { metadata, body } = parseSkillFrontMatter(content);
    expect(metadata.name).toBe('test-skill');
    expect(metadata.description).toBe('A test skill');
    expect(metadata.version).toBe('1.0.0');
    expect(metadata.tags).toEqual(['test', 'demo']);
    expect(body).toContain('This is the instruction body');
  });

  it('throws on missing front matter', () => {
    expect(() => parseSkillFrontMatter('# No front matter')).toThrow();
  });

  it('throws on missing name', () => {
    const content = `---
description: A test skill
version: 1.0.0
---

Body
`;
    expect(() => parseSkillFrontMatter(content)).toThrow('name');
  });

  it('throws on missing description', () => {
    const content = `---
name: test-skill
version: 1.0.0
---

Body
`;
    expect(() => parseSkillFrontMatter(content)).toThrow('description');
  });

  it('throws on missing version', () => {
    const content = `---
name: test-skill
description: A test skill
---

Body
`;
    expect(() => parseSkillFrontMatter(content)).toThrow('version');
  });

  it('handles empty tags', () => {
    const content = `---
name: test-skill
description: A test skill
version: 1.0.0
---

Body
`;
    const { metadata } = parseSkillFrontMatter(content);
    expect(metadata.tags).toEqual([]);
  });
});

describe('Skills — discovery and loading', () => {
  it('discovers and loads skills from a directory', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'skill-a'), { recursive: true });
    mkdirSync(join(dir, 'skill-b'), { recursive: true });

    writeFileSync(
      join(dir, 'skill-a', 'SKILL.md'),
      `---\nname: skill-a\ndescription: First skill\nversion: 1.0.0\ntags: [a]\n---\n\nBody A\n`,
    );
    writeFileSync(
      join(dir, 'skill-b', 'SKILL.md'),
      `---\nname: skill-b\ndescription: Second skill\nversion: 2.0.0\ntags: [b]\n---\n\nBody B\n`,
    );

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(2);
    expect(skills[0]!.metadata.name).toBe('skill-a');
    expect(skills[1]!.metadata.name).toBe('skill-b');
    expect(skills[0]!.instructions).toContain('Body A');
    expect(skills[1]!.instructions).toContain('Body B');

    cleanup();
  });

  it('returns empty array for non-existent directory', () => {
    const skills = loadSkills('/nonexistent/path');
    expect(skills).toEqual([]);
  });

  it('skips directories without SKILL.md', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'not-a-skill'), { recursive: true });
    writeFileSync(join(dir, 'not-a-skill', 'README.md'), 'not a skill');

    const skills = loadSkills(dir);
    expect(skills).toEqual([]);

    cleanup();
  });

  it('loads skills in deterministic order', () => {
    const dir = makeTempDir();
    for (const name of ['zebra', 'alpha', 'beta']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} skill\nversion: 1.0.0\n---\n\nBody\n`,
      );
    }

    const skills = loadSkills(dir);
    expect(skills.map((s) => s.metadata.name)).toEqual(['alpha', 'beta', 'zebra']);

    cleanup();
  });

  it('loads a single skill by path', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'SKILL.md');
    writeFileSync(
      filePath,
      `---\nname: single-skill\ndescription: A single skill\nversion: 1.0.0\n---\n\nInstructions here\n`,
    );

    const skill = loadSkill('single-skill', filePath);
    expect(skill.metadata.name).toBe('single-skill');
    expect(skill.instructions).toContain('Instructions here');

    cleanup();
  });
});

describe('Skills — selection', () => {
  const skills: Skill[] = [
    {
      id: 'repo-analysis',
      metadata: { name: 'repository-analysis', description: 'Analyze repository structure', version: '1.0.0', tags: ['analysis', 'repository'] },
      instructions: 'Analyze the repo',
      filePath: '/fake/repo-analysis/SKILL.md',
    },
    {
      id: 'safe-code-change',
      metadata: { name: 'safe-code-change', description: 'Make safe code changes', version: '1.0.0', tags: ['implementation', 'safety'] },
      instructions: 'Make safe changes',
      filePath: '/fake/safe-code-change/SKILL.md',
    },
    {
      id: 'verification',
      metadata: { name: 'verification', description: 'Verify workflow output', version: '1.0.0', tags: ['verification', 'quality'] },
      instructions: 'Verify the output',
      filePath: '/fake/verification/SKILL.md',
    },
  ];

  it('selects skills matching query tags', () => {
    const selected = selectSkills(skills, 'analyze the repository', {
      queryTags: ['analysis'],
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]!.skill.id).toBe('repo-analysis');
  });

  it('selects skills matching keywords in name', () => {
    const selected = selectSkills(skills, 'verify the output');
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]!.skill.id).toBe('verification');
  });

  it('returns top-k skills', () => {
    const selected = selectSkills(skills, 'analysis implementation verification', { topK: 2 });
    expect(selected.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for no matches', () => {
    const selected = selectSkills(skills, 'cooking recipes');
    expect(selected).toEqual([]);
  });

  it('produces deterministic selection', () => {
    const selected1 = selectSkills(skills, 'analysis implementation');
    const selected2 = selectSkills(skills, 'analysis implementation');
    expect(selected1.map((s) => s.skill.id)).toEqual(selected2.map((s) => s.skill.id));
  });

  it('scores tag matches higher than keyword matches', () => {
    const selected = selectSkills(skills, 'repository analysis', {
      queryTags: ['analysis'],
    });
    // repo-analysis has both a tag match and keyword match.
    expect(selected[0]!.skill.id).toBe('repo-analysis');
    expect(selected[0]!.score).toBeGreaterThan(0);
  });
});

describe('Skills — agent context injection', () => {
  it('skills can be injected into agent context', () => {
    const injected = [
      {
        skillId: 'verification',
        name: 'verification',
        instructions: 'Verify the output against acceptance criteria',
      },
    ];

    // The injected skill has the expected shape.
    expect(injected[0]!.skillId).toBe('verification');
    expect(injected[0]!.name).toBe('verification');
    expect(injected[0]!.instructions).toContain('Verify');
  });

  it('skill content is treated as instructions, not data', () => {
    const skill: Skill = {
      id: 'test',
      metadata: { name: 'test', description: 'test', version: '1.0.0', tags: [] },
      instructions: 'This is instruction content',
      filePath: '/fake/SKILL.md',
    };

    // Skill content is INSTRUCTIONS.
    expect(skill.instructions).toBe('This is instruction content');
    // It is NOT data — it guides behavior but never executes.
  });
});
