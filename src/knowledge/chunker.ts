import type { DocumentChunk, KnowledgeDocument } from './document.js';

/** Configuration for deterministic chunking. */
export interface ChunkerOptions {
  /** Target chunk size in characters. Defaults to 500. */
  readonly chunkSize?: number;
  /** Overlap between consecutive chunks in characters. Defaults to 50. */
  readonly overlap?: number;
  /** Split on paragraph boundaries when possible. Defaults to true. */
  readonly respectParagraphs?: boolean;
}

/**
 * Deterministic chunker for knowledge documents.
 *
 * Splits document content into overlapping chunks of approximately
 * `chunkSize` characters. When `respectParagraphs` is true (default),
 * the chunker prefers paragraph boundaries (`\n\n`) as split points,
 * falling back to sentence boundaries (`. `) and then hard splits.
 *
 * The same document content always produces the same chunks — no
 * randomness, no external services.
 */
export class DeterministicChunker {
  private readonly chunkSize: number;
  private readonly overlap: number;
  private readonly respectParagraphs: boolean;

  constructor(options: ChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? 500;
    this.overlap = options.overlap ?? 50;
    this.respectParagraphs = options.respectParagraphs ?? true;
  }

  /**
   * Split a document into deterministic chunks.
   *
   * Chunks are produced in document order. Each chunk carries
   * metadata for source attribution (document id, chunk index,
   * character offsets).
   */
  chunk(document: KnowledgeDocument): DocumentChunk[] {
    const { content } = document;
    if (content.length === 0) return [];

    const boundaries = this.respectParagraphs
      ? this.paragraphBoundaries(content)
      : [content];

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;
    let globalOffset = 0;

    for (const paragraph of boundaries) {
      if (paragraph.length === 0) continue;

      if (paragraph.length <= this.chunkSize) {
        // Small paragraph: emit as a single chunk.
        chunks.push(this.makeChunk(document, paragraph, chunkIndex, globalOffset));
        chunkIndex += 1;
        globalOffset += paragraph.length;
      } else {
        // Large paragraph: split into overlapping sub-chunks.
        const subChunks = this.splitLargeParagraph(paragraph, this.chunkSize, this.overlap);
        for (const sub of subChunks) {
          chunks.push(this.makeChunk(document, sub.text, chunkIndex, globalOffset + sub.startOffset));
          chunkIndex += 1;
        }
        globalOffset += paragraph.length;
      }
    }

    return chunks;
  }

  private makeChunk(
    document: KnowledgeDocument,
    text: string,
    chunkIndex: number,
    startOffset: number,
  ): DocumentChunk {
    return {
      id: `${document.id}:chunk-${chunkIndex}`,
      documentId: document.id,
      content: text,
      metadata: {
        documentId: document.id,
        source: document.metadata.source,
        chunkIndex,
        startOffset,
        endOffset: startOffset + text.length,
      },
    };
  }

  /**
   * Find paragraph boundaries in the content. Returns an array of
   * paragraph strings (without the trailing `\n\n`).
   */
  private paragraphBoundaries(content: string): string[] {
    // Split on one or more blank lines.
    const paragraphs = content.split(/\n\s*\n/);
    return paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
  }

  /**
   * Split a large paragraph into overlapping chunks, preferring
   * sentence boundaries near the target size.
   */
  private splitLargeParagraph(
    text: string,
    targetSize: number,
    overlap: number,
  ): Array<{ text: string; startOffset: number }> {
    const result: Array<{ text: string; startOffset: number }> = [];
    let pos = 0;

    while (pos < text.length) {
      const remaining = text.length - pos;
      if (remaining <= targetSize) {
        result.push({ text: text.slice(pos), startOffset: pos });
        break;
      }

      // Try to find a sentence boundary near the target size.
      const end = pos + targetSize;
      let splitAt = -1;

      // Look for `. ` (sentence end) in the last 20% of the target window.
      const searchStart = Math.max(pos + Math.floor(targetSize * 0.6), pos + 1);
      for (let i = end; i >= searchStart; i--) {
        if (text[i] === '.' && text[i + 1] === ' ') {
          splitAt = i + 1; // include the period
          break;
        }
      }

      // Fallback: look for any whitespace.
      if (splitAt === -1) {
        for (let i = end; i >= searchStart; i--) {
          if (/\s/.test(text[i]!)) {
            splitAt = i;
            break;
          }
        }
      }

      // Hard split if no boundary found.
      if (splitAt === -1 || splitAt <= pos) {
        splitAt = end;
      }

      result.push({ text: text.slice(pos, splitAt), startOffset: pos });
      pos = Math.max(splitAt, pos + targetSize - overlap);
    }

    return result;
  }
}
