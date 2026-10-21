/**
 * `themeseed magento-demo` — the demo-content exporter for Magento themes.
 *
 * Contract: docs/superpowers/specs/2026-10-21-magento-demo-content-contract.md
 * in the mcphub repo. Like the Ghost, WordPress and nic-demo exports this
 * bypasses `CmsProvider`: there is no live site, only a request file in and a
 * package out. The magento-theme plugin runs it as a subprocess and folds the
 * result into the theme zip.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ContentEngine } from '../../content/engine.js';
import { ThemeseedError } from '../../core/errors.js';
import { readVersion } from '../../core/version.js';
import type { ImageSourceOptions } from '../../images/index.js';
import type { ImageSource } from '../../images/source.js';
import { MediaCollector, type FetchBytes } from '../../nic-demo/media.js';
import { generateMagentoContent } from './generate.js';
import { chooseMagentoImageSource } from './media.js';
import { validateMagentoRequestSchema } from './schema.js';
import { validateMagentoContent, type MagentoCredits } from './validate.js';
import { writeMagentoPackage } from './write.js';
import type { MagentoContentRequest } from './types.js';

/** The caller got the invocation wrong (exit 2), as opposed to a refusal (exit 1). */
export class MagentoDemoUsageError extends ThemeseedError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'MAGENTO_DEMO_USAGE', ...(hint ? { hint } : {}) });
    this.name = 'MagentoDemoUsageError';
  }
}

export interface MagentoDemoOptions {
  /** Path to a content-request JSON file, or the already-parsed object. */
  request: string | Record<string, unknown>;
  /** The theme's `demo/` directory. Only `catalog.json` and `content-media/` are written. */
  outDir: string;
  /** Where credits go. Must be outside `outDir` — it would ship in the theme zip. */
  creditsPath: string;
  /** Test seams. */
  imageSource?: ImageSource;
  imageSourceOptions?: ImageSourceOptions;
  fetchBytes?: FetchBytes;
  engine?: ContentEngine;
  env?: NodeJS.ProcessEnv;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface MagentoDemoReport {
  ok: true;
  /** Paths relative to `outDir`. */
  written: string[];
  counts: Record<string, number>;
  credits: string;
  warnings: string[];
}

export async function exportMagentoDemo(
  options: MagentoDemoOptions
): Promise<MagentoDemoReport> {
  const request = await loadRequest(options.request);

  const outDir = path.resolve(options.outDir);
  const creditsPath = path.resolve(options.creditsPath);
  if (creditsPath === outDir || creditsPath.startsWith(outDir + path.sep)) {
    throw new MagentoDemoUsageError(
      `--credits (${options.creditsPath}) is inside --out (${options.outDir}); it would ship in the theme zip`,
      'Write credits next to the content request, outside the theme folder.'
    );
  }

  const warnings: string[] = [];
  const choice = await chooseMagentoImageSource(request.images?.source ?? 'auto', {
    ...(options.imageSource ? { override: options.imageSource } : {}),
    ...(options.imageSourceOptions ? { sourceOptions: options.imageSourceOptions } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  warnings.push(...choice.warnings);

  const media = new MediaCollector(request.store.name, options.fetchBytes);
  const version = await readVersion();
  const generated = await generateMagentoContent({
    request,
    media,
    imageSource: choice.source,
    generator: `themeseed@${version}`,
    ...(options.engine ? { engine: options.engine } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  warnings.push(...generated.warnings);

  // Asked for images, got none: a storefront demo whose every product sits
  // behind Magento's grey "no image" placeholder is a failed run, not a
  // partial one.
  if (choice.source && media.files.length === 0 && media.skipped > 0) {
    throw new ThemeseedError(
      `Every image was rejected (${media.skipped}); refusing to write a demo with no pictures`,
      {
        code: 'NO_USABLE_IMAGES',
        hint:
          'Images must be jpg/png/webp, at most 2000px on the long edge and 500 KB each. ' +
          `First problem: ${media.warnings[0] ?? 'see warnings'}. Resize the source images or use another image source.`,
      }
    );
  }

  const credits: MagentoCredits = {
    assets: [...media.credits].sort((a, b) => a.path.localeCompare(b.path)),
  };

  const problems = validateMagentoContent(generated.content, {
    media: media.files,
    credits,
  });
  if (problems.length > 0) {
    throw new ThemeseedError(
      `Refusing to write: the generated package is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
      {
        code: 'INVALID_OUTPUT',
        hint:
          problems.slice(0, 8).join('; ') +
          (problems.length > 8 ? `; …and ${problems.length - 8} more` : '') +
          '. If a seed caused it, fix that seed in the content request.',
      }
    );
  }

  const written = await writeMagentoPackage({
    outDir,
    creditsPath,
    content: generated.content,
    media: media.files,
    credits,
  });

  return {
    ok: true,
    written,
    counts: generated.counts,
    credits: options.creditsPath,
    warnings,
  };
}

async function loadRequest(
  source: string | Record<string, unknown>
): Promise<MagentoContentRequest> {
  let doc: unknown = source;
  if (typeof source === 'string') {
    let raw: string;
    try {
      raw = await fs.readFile(source, 'utf8');
    } catch (err) {
      throw new MagentoDemoUsageError(
        `Cannot read the content request ${source}: ${err instanceof Error ? err.message : String(err)}`,
        'Pass --request <path to a magento-content-request/1 JSON file>.'
      );
    }
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new MagentoDemoUsageError(
        `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const problems = validateMagentoRequestSchema(doc);
  if (problems.length > 0) {
    throw new MagentoDemoUsageError(
      `The content request is not a valid magento-content-request/1 document:\n  - ${problems.join('\n  - ')}`,
      'Fix the request (schema: magento-content-request-1.schema.json).'
    );
  }
  const request = doc as MagentoContentRequest;

  checkKeys(request);
  return request;
}

/**
 * Cross-references the schema cannot express: unique keys across the whole
 * department tree, and every seed naming a category that exists. Caught here
 * rather than after generation, so a typo costs nothing.
 */
function checkKeys(request: MagentoContentRequest): void {
  const categoryKeys = new Set<string>();
  for (const department of request.catalog.departments) {
    if (categoryKeys.has(department.key)) {
      throw new MagentoDemoUsageError(
        `catalog.departments: key "${department.key}" appears twice`,
        'Department and child keys share one namespace and must be unique.'
      );
    }
    categoryKeys.add(department.key);
    for (const child of department.children ?? []) {
      if (categoryKeys.has(child.key)) {
        throw new MagentoDemoUsageError(
          `catalog.departments: key "${child.key}" appears twice`,
          'Department and child keys share one namespace and must be unique.'
        );
      }
      categoryKeys.add(child.key);
    }
  }

  const seedKeys = new Set<string>();
  for (const seed of request.catalog.seeds ?? []) {
    if (seedKeys.has(seed.key)) {
      throw new MagentoDemoUsageError(
        `catalog.seeds: key "${seed.key}" appears twice`,
        'Seed keys are the import idempotency key and must be unique.'
      );
    }
    seedKeys.add(seed.key);
    if (seed.category && !categoryKeys.has(seed.category)) {
      throw new MagentoDemoUsageError(
        `catalog.seeds."${seed.key}": unknown category "${seed.category}"`,
        `Name one of: ${[...categoryKeys].join(', ')}`
      );
    }
  }
}

export { validateMagentoContent } from './validate.js';
export { validateMagentoContentSchema, validateMagentoRequestSchema } from './schema.js';
export type { MagentoContent, MagentoContentRequest } from './types.js';
