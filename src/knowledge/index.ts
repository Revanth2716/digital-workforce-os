/**
 * Knowledge layer (Milestone 3).
 *
 * Local RAG / knowledge retrieval subsystem. Provides:
 * - Document ingestion and deterministic chunking
 * - Local inverted-index retrieval with TF-IDF scoring
 * - Grounded context construction with source attribution
 * - A `Retriever` interface for future embedding/vector implementations
 *
 * All content is treated as DATA — never as executable instructions.
 */
export * from './document.js';
export * from './chunker.js';
export * from './inverted-index.js';
export * from './retriever.js';
export * from './knowledge-store.js';
export * from './context-builder.js';
