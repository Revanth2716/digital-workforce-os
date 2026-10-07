import type { DocumentChunk, KnowledgeDocument, KnowledgeDocumentMetadata } from './document.js';
import { DeterministicChunker } from './chunker.js';
import { InvertedIndex } from './inverted-index.js';
import type { Retriever } from './retriever.js';
import { LocalRetriever } from './retriever.js';
import { sha256Hex } from '../core/json.js';

/**
 * Knowledge store (Milestone 3).
 *
 * Manages the full lifecycle of knowledge documents: ingestion,
 * deterministic chunking, local indexing, and retrieval. The
 * store is fully in-memory — no external vector database, no
 * network access, no paid services.
 *
 * All retrieved content is treated as DATA. The knowledge layer
 * never executes instructions found in documents; it only
 * returns relevant chunks with source attribution.
 */
export class KnowledgeStore {
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly chunks = new Map<string, DocumentChunk>();
  private readonly index: InvertedIndex;
  private readonly chunker: DeterministicChunker;
  private readonly retriever: LocalRetriever;
  private readonly clock: () => number;

  constructor(options: {
    readonly chunker?: DeterministicChunker;
    readonly clock?: () => number;
  } = {}) {
    this.index = new InvertedIndex();
    this.chunker = options.chunker ?? new DeterministicChunker();
    this.retriever = new LocalRetriever(this.index);
    this.clock = options.clock ?? (() => Date.now());
  }

  /** The retriever interface for querying the knowledge base. */
  getRetriever(): Retriever {
    return this.retriever;
  }

  /** The underlying inverted index (for testing and inspection). */
  getIndex(): InvertedIndex {
    return this.index;
  }

  /**
   * Ingest a document: chunk it, index the chunks, and store
   * the document metadata. Re-ingesting a document with the
   * same id replaces the old version.
   */
  ingest(
    content: string,
    metadata: KnowledgeDocumentMetadata,
    documentId?: string,
  ): KnowledgeDocument {
    const id = documentId ?? `doc-${sha256Hex(content).slice(0, 16)}`;

    // Remove old chunks if re-ingesting.
    if (this.documents.has(id)) {
      this.remove(id);
    }

    const document: KnowledgeDocument = {
      id,
      content,
      metadata: {
        ...metadata,
        contentHash: sha256Hex(content),
      },
      ingestedAt: this.clock(),
    };

    this.documents.set(id, document);

    const chunks = this.chunker.chunk(document);
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      this.index.add(chunk);
    }

    return document;
  }

  /** Remove a document and all its chunks from the store. */
  remove(documentId: string): boolean {
    if (!this.documents.has(documentId)) return false;
    this.index.removeDocument(documentId);
    // Remove chunk records.
    for (const chunkId of [...this.chunks.keys()]) {
      if (this.chunks.get(chunkId)?.documentId === documentId) {
        this.chunks.delete(chunkId);
      }
    }
    this.documents.delete(documentId);
    return true;
  }

  /** Get a document by id. */
  getDocument(documentId: string): KnowledgeDocument | undefined {
    return this.documents.get(documentId);
  }

  /** Get a chunk by id. */
  getChunk(chunkId: string): DocumentChunk | undefined {
    return this.chunks.get(chunkId);
  }

  /** List all document ids. */
  listDocuments(): string[] {
    return [...this.documents.keys()];
  }

  /** Number of documents in the store. */
  get documentCount(): number {
    return this.documents.size;
  }

  /** Number of chunks in the store. */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Retrieve relevant chunks for a query. Convenience method
   * that delegates to the retriever.
   */
  retrieve(query: string, topK?: number) {
    return this.retriever.retrieve(query, topK);
  }
}
