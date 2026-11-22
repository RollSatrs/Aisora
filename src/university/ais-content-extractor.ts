import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { Locator, Page } from 'playwright';
import { normalizeText } from './abu-parsers';

export interface ExtractedResource {
  name: string;
  text: string;
  contentHash: string;
}

@Injectable()
export class AisContentExtractor {
  constructor(private readonly config: ConfigService) {}

  async extractLinkedResources(page: Page, container: Locator, timeoutMs?: number): Promise<ExtractedResource[]> {
    const links = await container.locator('a').evaluateAll((elements) => elements.map((element) => ({
      name: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      href: element.getAttribute('href'),
      download: element.getAttribute('download'),
    })).filter((item) => Boolean(item.href)));
    const resources: ExtractedResource[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      const absoluteUrl = new URL(link.href!, page.url());
      if (absoluteUrl.hostname !== 'ais.semuniver.kz' || seen.has(absoluteUrl.href)) continue;
      if (!this.looksLikeDocument(link.name, absoluteUrl.pathname, link.download)) continue;
      seen.add(absoluteUrl.href);
      const resource = await this.downloadAndExtract(page, absoluteUrl.href, link.download || link.name || absoluteUrl.pathname, timeoutMs);
      if (resource) resources.push(resource);
    }
    return resources;
  }

  async downloadAndExtract(page: Page, url: string, name: string, timeoutMs?: number): Promise<ExtractedResource | undefined> {
    const response = await page.request.get(url, { timeout: timeoutMs ?? Number(this.config.get<string>('AIS_DOWNLOAD_TIMEOUT_MS') ?? 120_000) })
      .catch(() => undefined);
    if (!response?.ok()) return undefined;
    const maximum = Number(this.config.get<string>('AIS_MAX_ATTACHMENT_BYTES') ?? 15 * 1024 * 1024);
    const declaredLength = Number(response.headers()['content-length'] ?? 0);
    if (declaredLength > maximum) return undefined;
    const buffer = await response.body();
    if (buffer.length > maximum) return undefined;
    const contentType = response.headers()['content-type'] ?? '';
    const text = await extractTextFromBuffer(buffer, name, contentType);
    if (!text) return undefined;
    return {
      name: name.slice(0, 200),
      text: text.slice(0, Number(this.config.get<string>('AIS_MAX_EXTRACTED_TEXT_CHARS') ?? 100_000)),
      contentHash: createHash('sha256').update(buffer).digest('hex'),
    };
  }

  private looksLikeDocument(name: string, pathname: string, download: string | null): boolean {
    const value = `${name} ${pathname} ${download ?? ''}`;
    return /\.(pdf|docx?|txt|rtf|html?)(?:\s|$|\?)/i.test(value) || Boolean(download);
  }
}

export async function extractTextFromBuffer(buffer: Buffer, name: string, contentType: string): Promise<string> {
  const value = `${name} ${contentType}`.toLowerCase();
  try {
    if (value.includes('.pdf') || value.includes('application/pdf')) {
      const result = await pdfParse(buffer);
      return normalizeText(result.text);
    }
    if (value.includes('.docx') || value.includes('officedocument.wordprocessingml')) {
      const result = await mammoth.extractRawText({ buffer });
      return normalizeText(result.value);
    }
    if (/\.(txt|rtf|html?)\b/.test(value) || value.includes('text/')) {
      return normalizeText(buffer.toString('utf8'));
    }
  } catch {
    return '';
  }
  return '';
}
