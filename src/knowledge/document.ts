/**
 * Knowledge document and chunk types (Milestone 3).
 *
 * A `KnowledgeDocument` is an ingested local document (Markdown or
 * plain text). It is split into deterministic `DocumentChunk`s,
 * each carrying metadata for source attribution. The knowledge
 * layer treats all retrieved content as DATA — never as
 * executable instructions.
 */

/** Metadata attached to a knowledge document. */
export interface KnowledgeDocumentMetadata {
  /** Original file path or logical source name. */
  readonly source: string;
  /** Document title, if known. */
  readonly title?: string;
  /** MIME type or content type (e.g. `text/markdown`). */
  readonly contentType?: string;
  /** Free-form tags for filtering. */
  readonly tags?: readonly string[];
  /** SHA-256 of the original content, for integrity checks. */
  readonly contentHash?: string;
}

/** An ingested knowledge document. */
export interface KnowledgeDocument {
  readonly id: string;
  readonly content: string;
  readonly metadata: KnowledgeDocumentMetadata;
  /** When the document was ingested (ms since epoch). */
  readonly ingestedAt: number;
}

/** Metadata attached to a single chunk. */
export interface ChunkMetadata {
  /** Parent document id. */
  readonly documentId: string;
  /** Source path from the parent document. */
  readonly source: string;
  /** Zero-based chunk index within the document. */
  readonly chunkIndex: number;
  /** Start character offset in the original document. */
  readonly startOffset: number;
  /** End character offset in the original document. */
  readonly endOffset: number;
}

/** A deterministic chunk of a knowledge document. */
export interface DocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly metadata: ChunkMetadata;
}
