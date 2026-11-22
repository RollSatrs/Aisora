import { createHash } from 'node:crypto';
import type { AssignmentSnapshot, AssignmentType } from '../domain/models';

export interface SentMessageObservation {
  externalRef: string;
  sentAt: string;
  subject: string;
  body?: string;
  resourceTexts?: string[];
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function stableExternalRef(parts: string[]): string {
  return createHash('sha256').update(parts.map(normalizeText).join('|')).digest('hex').slice(0, 24);
}

export function parseSroText(courseRef: string, text: string): AssignmentSnapshot[] {
  const normalized = normalizeText(text);
  const pattern = /Самостоятельная работа\s+(\d+)\s+неделя\s+(---|\d+)\s+Срок сдачи работы до\s+(\d{4}-\d{2}-\d{2})/g;
  return [...normalized.matchAll(pattern)].map((match) => {
    const weekNumber = Number(match[1]);
    const score = match[2] === '---' ? undefined : match[2];
    const title = `Самостоятельная работа ${weekNumber} неделя`;
    return {
      externalRef: `abu-sro-${stableExternalRef([courseRef, String(weekNumber), match[3] ?? ''])}`,
      courseRef,
      type: 'SRO',
      title,
      weekNumber,
      content: `${title}; срок ${match[3]}`,
      requiredState: 'REQUIRED',
      source: 'SRO_TAB',
      submitted: score !== undefined,
      submissionState: score !== undefined ? 'CONFIRMED' : 'UNKNOWN',
      grade: score,
    };
  });
}

/**
 * Message evidence for SRSP/SROP and LAB can only match subjects with these
 * labels (see messageMatches). Other subjects need no expensive body view.
 */
export function isRelevantSentSubject(subject: string): boolean {
  return /срсп|сроп|лаб(?:ораторн)?/i.test(subject);
}

/** Scan only future academic weeks with a pending SRO-tab card. */
export function futureSroWeeks(
  currentWeek: number,
  availableWeeks: readonly number[],
  cards: readonly Pick<AssignmentSnapshot, 'type' | 'source' | 'weekNumber' | 'grade'>[],
): number[] {
  const available = new Set(availableWeeks);
  return [...new Set(cards
    .filter((card) => card.type === 'SRO'
      && card.source === 'SRO_TAB'
      && card.weekNumber > currentWeek
      && available.has(card.weekNumber)
      && card.grade === undefined)
    .map((card) => card.weekNumber))].sort((a, b) => a - b);
}

export function parseSentMessageRows(rows: string[]): SentMessageObservation[] {
  return rows.flatMap((row) => {
    const normalized = normalizeText(row);
    const match = normalized.match(/^(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\S+\s+(.+)$/);
    if (!match) return [];
    return [{ externalRef: match[1]!, sentAt: match[2]!, subject: match[3]! }];
  });
}

/**
 * ABU terminology: СРО/СРС are submitted via the СРО tab,
 * СРСП/СРОП via messages. The label's number is not the submission week.
 * Check longer labels first and accept nonstandard spacing/punctuation.
 */
export function independentWorkType(title: string): 'SRO' | 'SRSP' | undefined {
  const normalized = normalizeText(title);
  if (/(?:^|[\s(])(?:СРСП|СРОП)(?=$|[\s№\d.,:;()\-–—])/iu.test(normalized)) return 'SRSP';
  if (/(?:^|[\s(])(?:СРС|СРО)(?=$|[\s№\d.,:;()\-–—])/iu.test(normalized)) return 'SRO';
  return undefined;
}

export function contentType(title: string): AssignmentType | undefined {
  // A journal SRO label is read as a *brief*, not a second submission record.
  if (independentWorkType(title) === 'SRSP') return 'SRSP';
  if (/(?:^|\s)(?:Лаб|Лабораторн)/i.test(title)) return 'LAB';
  return undefined;
}

function significantWords(value: string): Set<string> {
  const stopWords = new Set(['работа', 'задание', 'неделя', 'лабораторная', 'срсп', 'сроп', 'этого', 'который']);
  return new Set(normalizeText(value).toLowerCase().split(/[^a-zа-яё0-9]+/i)
    .filter((word) => word.length >= 4 && !stopWords.has(word)));
}

export function contentSimilarity(expected: string, actual: string): number {
  const left = significantWords(expected);
  const right = significantWords(actual);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function messageMatches(
  type: AssignmentType,
  title: string,
  week: number,
  expectedContent: string,
  message: SentMessageObservation,
): boolean {
  const value = normalizeText(message.subject).toLowerCase();
  const messageContent = [message.subject, message.body ?? '', ...(message.resourceTexts ?? [])].join(' ');
  const assignmentNumber = title.match(/№\s*(\d+)/i)?.[1];
  const numberMatches = Boolean(assignmentNumber && new RegExp(`(?:№\\s*|\\b)${assignmentNumber}\\b`, 'i').test(value));
  const weekMatches = value.includes(`${week} неделя`) || value.includes(`${week}-я неделя`);
  const similarContent = contentSimilarity(expectedContent, messageContent) >= 0.28;
  if (type === 'SRSP') {
    if (!/срсп|сроп/i.test(value)) return false;
    // The ordinal №4 is not a week and cannot on its own confirm submission.
    // An explicit, different academic week is conflicting evidence.
    const statedWeek = value.match(/(\d{1,2})\s*(?:-\s*[яй])?\s*недел[яи]/i)?.[1];
    if (statedWeek && Number(statedWeek) !== week) return false;
    return weekMatches || (!statedWeek && similarContent);
  }
  if (type === 'LAB') {
    const number = title.match(/(?:№|лаб(?:ораторная работа)?\s*)(\d+)/i)?.[1];
    const labNumberMatches = !number || new RegExp(`(?:№\\s*|лаб\\s*)${number}\\b`, 'i').test(value);
    return /лаб/i.test(value) && (labNumberMatches || weekMatches || similarContent);
  }
  return false;
}

export function parseContentAssignments(
  courseRef: string,
  weekNumber: number,
  titles: string[],
  sent: SentMessageObservation[],
  detailsByTitle: ReadonlyMap<string, string> = new Map(),
): AssignmentSnapshot[] {
  return titles.flatMap((rawTitle) => {
    const title = normalizeText(rawTitle);
    const type = contentType(title);
    if (!type) return [];
    const content = detailsByTitle.get(title) ?? title;
    const submitted = sent.some((message) => messageMatches(type, title, weekNumber, content, message));
    return [{
      externalRef: `abu-content-${stableExternalRef([courseRef, String(weekNumber), type, title])}`,
      courseRef,
      type,
      title,
      weekNumber,
      content,
      requiredState: 'REQUIRED',
      source: 'CONTENT',
      submitted,
      submissionState: submitted ? 'CONFIRMED' : 'ABSENT',
    } satisfies AssignmentSnapshot];
  });
}
