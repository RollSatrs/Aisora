import type { AssignmentSnapshot } from '../domain/models';
import { normalizeText } from './abu-parsers';

/** An extracted SRO brief is not a submission target. A target is an SRO_TAB card. */
export interface WeeklySroBrief {
  courseRef: string;
  weekNumber: number;
  title: string;
  content: string;
}

export type SroMatchResult =
  | { status: 'MATCHED'; brief: WeeklySroBrief }
  | { status: 'MISSING'; reason: string }
  | { status: 'AMBIGUOUS'; reason: string; candidates: string[] };

/**
 * Only match within the same course and week, and only to an SRO tab card.
 * The number in "СРО №3" is an assignment number, NOT its submission week.
 * Never pick the first of multiple candidates: a wrong upload is worse than
 * requesting manual clarification.
 */
export function matchSroBrief(
  target: Pick<AssignmentSnapshot, 'courseRef' | 'weekNumber' | 'type' | 'source'>,
  briefs: readonly WeeklySroBrief[],
): SroMatchResult {
  if (target.type !== 'SRO' || target.source !== 'SRO_TAB') {
    return { status: 'MISSING', reason: 'Only SRO tab cards can be destinations' };
  }
  const candidates = briefs.filter((brief) =>
    brief.courseRef === target.courseRef &&
    brief.weekNumber === target.weekNumber &&
    /^\s*(?:СРО|СРС)(?:\s|№|\d|[.:]|$)/i.test(normalizeText(brief.title)) &&
    normalizeText(brief.content).length > normalizeText(brief.title).length,
  );
  if (!candidates.length) {
    return { status: 'MISSING', reason: 'No fully read SRO brief for this course and week' };
  }
  if (candidates.length > 1) {
    return {
      status: 'AMBIGUOUS',
      reason: 'Multiple SRO briefs share the course and week; manual selection required',
      candidates: candidates.map((candidate) => candidate.title),
    };
  }
  return { status: 'MATCHED', brief: candidates[0]! };
}

/** A structured, non-generative summary for document-generation planning. */
export interface SroRequirements {
  title: string;
  fullText: string;
  reportType?: string;
  pageRange?: { min: number; max: number };
  font?: string;
  fontSize?: string;
  lineSpacing?: string;
  minimumSources?: number;
  requiresTitlePage: boolean;
  requiresReferences: boolean;
  requiresOriginalityCheck: boolean;
}

export function extractSroRequirements(brief: WeeklySroBrief): SroRequirements {
  const text = normalizeText(brief.content);
  const pages = text.match(/(?:Объ[её]м|объ[её]м)[^\d]{0,30}(\d+)\s*[-–—]\s*(\d+)\s*страниц/i);
  const font = text.match(/(?:Шрифт|шрифт)\s*[:—-]?\s*(Times New Roman|Arial|Calibri)/i);
  const fontSize = text.match(/размер\s*(\d+(?:[.,]\d+)?)\s*(?:pt|пт)?/i);
  const lineSpacing = text.match(/(?:Межстрочный интервал|интервал)\s*[:—-]?\s*(\d+(?:[.,]\d+)?)/i);
  const sources = text.match(/(?:Минимум|не менее)\s*(\d+)\s*источник/i);
  const reportType = text.match(/Форма отчетности\s*:\s*([^.;]{2,60})/i);
  return {
    title: brief.title,
    fullText: text,
    reportType: reportType?.[1]?.trim(),
    pageRange: pages ? { min: Number(pages[1]), max: Number(pages[2]) } : undefined,
    font: font?.[1],
    fontSize: fontSize?.[1],
    lineSpacing: lineSpacing?.[1],
    minimumSources: sources ? Number(sources[1]) : undefined,
    requiresTitlePage: /титульн(?:ый|ого)\s+лист/i.test(text),
    requiresReferences: /список\s+литературы|список\s+источников/i.test(text),
    requiresOriginalityCheck: /уникальност|оригинальност|антиплагиат/i.test(text),
  };
}
