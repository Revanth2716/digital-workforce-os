import type { DocumentChunk } from './document.js';

/**
 * Local inverted index for deterministic retrieval (Milestone 3).
 *
 * Maintains a term -> chunk-ids inverted index with term
 * frequencies, enabling TF-IDF scoring without any external
 * vector database. The index is fully in-memory and
 * deterministic: the same set of chunks always produces the
 * same index and the same retrieval results.
 */

/** Tokenize text into lowercase alphanumeric terms. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

/** Posting list entry: chunk id and term frequency. */
interface Posting {
  readonly chunkId: string;
  readonly termFrequency: number;
}

/** A single chunk's indexed data. */
interface IndexedChunk {
  readonly chunk: DocumentChunk;
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly termCount: number;
}

/**
 * Inverted index over document chunks.
 *
 * Supports deterministic top-k retrieval using TF-IDF scoring.
 * No external services, no embeddings, no network access.
 */
export class InvertedIndex {
  private readonly chunks = new Map<string, IndexedChunk>();
  private readonly inverted = new Map<string, Posting[]>();
  private totalChunks = 0;

  /** Add a chunk to the index. */
  add(chunk: DocumentChunk): void {
    if (this.chunks.has(chunk.id)) return; // idempotent

    const terms = tokenize(chunk.content);
    const termFrequencies = new Map<string, number>();
    for (const term of terms) {
      termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
    }

    this.chunks.set(chunk.id, { chunk, termFrequencies, termCount: terms.length });
    this.totalChunks += 1;

    for (const [term, freq] of termFrequencies) {
      const postings = this.inverted.get(term) ?? [];
      postings.push({ chunkId: chunk.id, termFrequency: freq });
      this.inverted.set(term, postings);
    }
  }

  /** Remove a chunk from the index. */
  remove(chunkId: string): void {
    const entry = this.chunks.get(chunkId);
    if (entry === undefined) return;

    for (const term of entry.termFrequencies.keys()) {
      const postings = this.inverted.get(term);
      if (postings === undefined) continue;
      const filtered = postings.filter((p) => p.chunkId !== chunkId);
      if (filtered.length === 0) {
        this.inverted.delete(term);
      } else {
        this.inverted.set(term, filtered);
      }
    }

    this.chunks.delete(chunkId);
    this.totalChunks -= 1;
  }

  /** Remove all chunks belonging to a document. */
  removeDocument(documentId: string): void {
    const toRemove: string[] = [];
    for (const [chunkId, entry] of this.chunks) {
      if (entry.chunk.documentId === documentId) {
        toRemove.push(chunkId);
      }
    }
    for (const chunkId of toRemove) {
      this.remove(chunkId);
    }
  }

  /** Number of chunks in the index. */
  get size(): number {
    return this.totalChunks;
  }

  /** All chunk ids in the index. */
  get chunkIds(): string[] {
    return [...this.chunks.keys()];
  }

  /** Look up a chunk by id. */
  getChunk(chunkId: string): DocumentChunk | undefined {
    return this.chunks.get(chunkId)?.chunk;
  }

  /**
   * Retrieve the top-k chunks for a query using TF-IDF scoring.
   *
   * Scoring: for each query term, compute TF-IDF against every
   * chunk containing that term. Sum across query terms. Return
   * the top-k chunks sorted by score (descending), with ties
   * broken by chunk id (ascending) for determinism.
   */
  search(query: string, topK: number = 5): Array<{ chunk: DocumentChunk; score: number }> {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.totalChunks === 0) return [];

    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const postings = this.inverted.get(term);
      if (postings === undefined) continue;

      // IDF: log(N / df) where df = number of chunks containing the term.
      const df = postings.length;
      const idf = Math.log(this.totalChunks / df) + 1;

      for (const posting of postings) {
        const entry = this.chunks.get(posting.chunkId);
        if (entry === undefined) continue;

        // TF: normalized term frequency (tf / termCount).
        const tf = posting.termFrequency / entry.termCount;
        const tfidf = tf * idf;

        scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + tfidf);
      }
    }

    // Sort by score descending, then chunk id ascending for determinism.
    const ranked = [...scores.entries()]
      .map(([chunkId, score]) => ({
        chunk: this.chunks.get(chunkId)?.chunk,
        score,
      }))
      .filter((entry): entry is { chunk: DocumentChunk; score: number } => entry.chunk !== undefined)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.chunk.id.localeCompare(b.chunk.id);
      });

    return ranked.slice(0, topK);
  }
}
