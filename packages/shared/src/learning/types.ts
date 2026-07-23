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

/** A persisted selection for an EPUB opened directly from a Project working directory. */
export interface WorkingFileEpubHighlight {
  /** Normalized Project working-directory relative path. Never an absolute path or basename guess. */
  sourcePath: string;
  /** Content digest that keeps highlights from a replaced edition from attaching to a new file. */
  sourceFingerprint: string;
  cfiRange: string;
  text: string;
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  spineIndex: number;
  createdAt: number;
}

export type WorkingFileEpubHighlightInput = Omit<WorkingFileEpubHighlight, 'createdAt'>;
