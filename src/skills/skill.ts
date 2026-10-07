/**
 * Skill types (Milestone 3).
 *
 * Skills are version-controlled Markdown files with YAML front
 * matter metadata. They provide reusable instructions that can
 * be discovered, loaded, and injected into agent contexts.
 *
 * Skill content is treated as INSTRUCTIONS — it guides agent
 * behavior but never executes arbitrary commands. All tool
 * execution still passes through the ToolRegistry.
 */

/** Parsed front matter metadata from a skill file. */
export interface SkillMetadata {
  /** Skill name (required). */
  readonly name: string;
  /** Short description of what the skill does. */
  readonly description: string;
  /** Semantic version string. */
  readonly version: string;
  /** Free-form tags for selection. */
  readonly tags: readonly string[];
}

/** A loaded skill with metadata and instruction content. */
export interface Skill {
  /** Unique skill identifier (directory name). */
  readonly id: string;
  /** Parsed front matter metadata. */
  readonly metadata: SkillMetadata;
  /** The instruction body (Markdown after front matter). */
  readonly instructions: string;
  /** Source file path. */
  readonly filePath: string;
}

/** A skill injected into an agent context. */
export interface InjectedSkill {
  readonly skillId: string;
  readonly name: string;
  readonly instructions: string;
}
