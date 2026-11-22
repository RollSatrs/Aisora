import { normalizeText } from './abu-parsers';

export type SroHistoryStatus = 'CONFIRMED' | 'ABSENT' | 'UNKNOWN';

export interface SroHistoryEvidence {
  status: SroHistoryStatus;
  files: string[];
  reason: string;
}

/**
 * Input controls are not evidence of an uploaded file. Only real file links
 * (not the "choose files" input) can confirm a prior upload.
 * Empty history is ABSENT only when the upload UI has loaded and settled.
 */
export function classifySroHistory(
  links: readonly string[],
  ready: boolean,
  settled: boolean,
): SroHistoryEvidence {
  const files = [...new Set(links.map(normalizeText).filter((text) =>
    /\.(?:docx?|pdf|xlsx?|pptx?|txt|rtf|zip|rar|7z)\b/i.test(text),
  ))];
  if (files.length) return { status: 'CONFIRMED', files, reason: 'uploaded file link visible' };
  if (!ready || !settled) return { status: 'UNKNOWN', files: [], reason: 'file history not confirmed loaded' };
  return { status: 'ABSENT', files: [], reason: 'upload UI loaded without any file links' };
}
