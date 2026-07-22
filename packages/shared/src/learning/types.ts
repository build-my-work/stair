export type TextbookFormat = 'markdown' | 'epub';

export type ChapterLocator =
  | {
      format: 'markdown';
      /** One-based, inclusive source line. */
      startLine: number;
      /** One-based, inclusive source line. */
      endLine: number;
    }
  | {
      format: 'epub';
      /** EPUB package-relative content path, without a fragment. */
      href: string;
      /** Zero-based position in the OPF spine. */
      spineIndex: number;
    };

/** A selectable chapter produced by any supported learning-material importer. */
export interface ImportedChapter {
  /** Deterministic, document-local identifier. */
  id: string;
  title: string;
  /** Source heading depth. Importers without heading levels should use 1. */
  level: number;
  /** Zero-based display and reading order. */
  order: number;
  /** Format-specific pointer back to the source document. */
  locator: ChapterLocator;
  /** Chapter body normalized to Markdown for the tutor. */
  content: string;
}

/** Format-neutral result returned by the textbook import pipeline. */
export interface ImportedTextbook {
  format: TextbookFormat;
  sourceFilename: string;
  title: string;
  author?: string;
  language?: string;
  chapters: ImportedChapter[];
}

/** A persisted text selection inside an EPUB textbook. */
export interface EpubHighlight {
  /** Persisted project asset filename. */
  sourceFilename: string;
  /** EPUB CFI range used to restore and navigate to the selection. */
  cfiRange: string;
  /** Selected text snapshot used by the highlights list and export. */
  text: string;
  /** Deterministic chapter identifier produced by the EPUB importer. */
  chapterId: string;
  /** Chapter title snapshot used even if the book cannot be reparsed later. */
  chapterTitle: string;
  /** Zero-based chapter display order. */
  chapterOrder: number;
  /** Zero-based OPF spine position containing the selection. */
  spineIndex: number;
  /** Unix timestamp assigned by the server when first saved. */
  createdAt: number;
}

/** Client input for a highlight; creation time is assigned by the server. */
export type EpubHighlightInput = Omit<EpubHighlight, 'createdAt'>;

/** Small durable pointer identifying what a tutor session is teaching. */
export interface LearningSessionContext {
  sourceFilename: string;
  textbookTitle: string;
  chapterId: string;
  chapterTitle: string;
  format: TextbookFormat;
}
