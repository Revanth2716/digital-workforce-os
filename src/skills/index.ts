/**
 * Skills system (Milestone 3).
 *
 * Version-controlled Markdown skills with discovery, metadata
 * parsing, loading, deterministic selection, and injection
 * into agent contexts.
 *
 * Skill content is treated as INSTRUCTIONS — it guides agent
 * behavior but never executes arbitrary commands.
 */
export * from './skill.js';
export * from './skill-loader.js';
export * from './skill-selector.js';
