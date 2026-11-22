import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Locator } from 'playwright';

/**
 * Opt-in diagnostic fragments only, never a full authenticated page.
 * Retains element names, IDs, classes, labels and text for parser diagnosis,
 * but drops potentially sensitive attributes, form values, scripts and links.
 */
@Injectable()
export class AisHtmlDiagnostics {
  private readonly logger = new Logger(AisHtmlDiagnostics.name);
  constructor(private readonly config: ConfigService) {}

  async capture(accountId: string, courseRef: string, week: number, kind: string, locator: Locator): Promise<void> {
    if (this.config.get<string>('AIS_SAVE_DIAGNOSTIC_HTML') !== 'true') return;
    try {
      const html = await locator.evaluate((element) => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script,style,iframe,form,textarea,input,select,option,svg,img,video,audio,canvas')
          .forEach((node) => node.remove());
        const sanitize = (node: Element) => {
          for (const attr of [...node.attributes]) {
            if (!['id', 'class', 'role', 'type', 'aria-label', 'title'].includes(attr.name)) {
              node.removeAttribute(attr.name);
            }
          }
          for (const child of [...node.children]) sanitize(child);
        };
        sanitize(clone);
        // No live links, cookies, hidden input values or executable JS.
        return clone.outerHTML.slice(0, 100_000);
      });
      const base = resolve(this.config.get<string>('AIS_HTML_DIAGNOSTICS_DIR') || 'artifacts/ais-html');
      const account = createHash('sha256').update(accountId).digest('hex').slice(0, 12);
      const course = createHash('sha256').update(courseRef).digest('hex').slice(0, 12);
      const dir = join(base, account);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const safeKind = kind.replace(/[^a-z0-9-]/gi, '-').slice(0, 32);
      const path = join(dir, `${course}-week-${week}-${safeKind}.html`);
      await writeFile(path, html, { encoding: 'utf8', mode: 0o600 });
      this.logger.log(`Saved limited AIS HTML diagnostic: ${path}`);
    } catch (error) {
      this.logger.warn(`Could not save diagnostic fragment: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
}
