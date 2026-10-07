import type { DocumentChunk } from './document.js';
import { InvertedIndex } from './inverted-index.js';

/**
 * Retriever interface (Milestone 3).
 *
 * Defines the contract for knowledge retrieval. The current
 * implementation is a local TF-IDF retriever over an inverted
 * index. A future embedding/vector implementation can replace
 * it without changing agent code — agents depend only on this
 * interface.
 */
export interface Retriever {
  /**
   * Retrieve the top-k most relevant chunks for a query.
   * Returns chunks with relevance scores and source attribution.
   */
  retrieve(query: string, topK?: number): RetrievalResult;
}

/** A single retrieved chunk with its relevance score. */
export interface RetrievedChunk {
  readonly chunk: DocumentChunk;
  /** Relevance score (higher = more relevant). */
  readonly score: number;
}

/** The result of a retrieval operation. */
export interface RetrievalResult {
  readonly query: string;
  readonly chunks: readonly RetrievedChunk[];
  /** Total number of chunks considered (before top-k truncation). */
  readonly totalCandidates: number;
}

/**
 * Local TF-IDF retriever over an in-memory inverted index.
 *
 * Fully deterministic: the same index and query always produce
 * the same results. No external services, no embeddings, no
 * network access.
 */
export class LocalRetriever implements Retriever {
  private readonly index: InvertedIndex;

  constructor(index: InvertedIndex) {
    this.index = index;
  }

  retrieve(query: string, topK: number = 5): RetrievalResult {
    const results = this.index.search(query, topK);
    return {
      query,
      chunks: results.map((r) => ({ chunk: r.chunk, score: r.score })),
      totalCandidates: this.index.size,
    };
  }
}
