/**
 * Assembling a `magento-content/1` package: the catalog plan from
 * `catalog.ts`, prose from the content engine, images from whichever source
 * was chosen, and CMS pages and blocks written in Magento's own directive
 * dialect.
 *
 * The prose rule inherited from the magento-theme plugin, and worth repeating
 * because it is an ethics rule rather than a style one: generated copy may
 * describe what the generator structurally guarantees, and may use the names
 * the caller supplied, but it must never assert anything about a real
 * business — no invented address, phone number, founding date, certification,
 * delivery promise or named testimonial.
 */

import {
  TemplateContentEngine,
  type ContentEngine,
  hashString,
} from '../../content/engine.js';
import { seededRandom } from '../../images/png.js';
import type { ImageSource } from '../../images/source.js';
import { MediaCollector } from '../../nic-demo/media.js';
import { planCatalog } from './catalog.js';
import { blocksToMagentoHtml, escapeHtml, storeUrl } from './directives.js';
import type {
  MagentoCategory,
  MagentoCmsBlock,
  MagentoCmsPage,
  MagentoContent,
  MagentoContentRequest,
  MagentoProduct,
} from './types.js';

export interface GenerateMagentoOptions {
  request: MagentoContentRequest;
  media: MediaCollector;
  /** Null means the package carries no images. */
  imageSource: ImageSource | null;
  generator: string;
  engine?: ContentEngine;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface GenerateMagentoResult {
  content: MagentoContent;
  counts: Record<string, number>;
  warnings: string[];
}

export async function generateMagentoContent(
  options: GenerateMagentoOptions
): Promise<GenerateMagentoResult> {
  const { request, media, imageSource } = options;
  const engine = options.engine ?? new TemplateContentEngine();
  const topic = request.store.topic;
  const warnings: string[] = [];

  if (request.store.language && !/^en(\b|[-_])/i.test(request.store.language)) {
    warnings.push(
      `store.language "${request.store.language}" is not supported by the built-in prose engine; the demo text is English`
    );
  }

  const plan = planCatalog(request);
  warnings.push(...plan.warnings);

  const total =
    plan.products.length + (request.pages?.length ?? 0) + (request.blocks?.length ?? 0);
  let done = 0;
  const step = (label: string): void => options.onProgress?.(++done, total, label);

  // Categories first: a category image is the banner a listing page renders
  // behind its heading, and Luma sets one on every department.
  for (const category of flatten(plan.categories)) {
    if (!imageSource) break;
    const path = await addImage(
      media,
      imageSource,
      `${category.name} ${topic}`,
      `cat-${category.key}`,
      'feature'
    );
    if (path) category.image = path;
  }

  for (const product of plan.products) {
    await describeProduct(product, { topic, engine, media, imageSource });
    step(product.name);
  }

  const pages = await buildPages(request, engine, warnings);
  for (const page of pages) step(page.title);

  const blocks = buildBlocks(request, plan.categories);
  for (const block of blocks) step(block.title);

  const content: MagentoContent = {
    format: 'magento-content/1',
    generator: options.generator,
    theme: request.theme,
    ...(plan.attributes.length ? { attributes: plan.attributes } : {}),
    ...(plan.attributeSets.length ? { attribute_sets: plan.attributeSets } : {}),
    categories: plan.categories,
    products: plan.products,
    ...(pages.length ? { pages } : {}),
    ...(blocks.length ? { blocks } : {}),
  };

  return {
    content,
    counts: {
      attributes: plan.attributes.length,
      attribute_sets: plan.attributeSets.length,
      categories: flatten(plan.categories).length,
      products: plan.products.length,
      variants: plan.products.reduce((n, p) => n + (p.variants?.length ?? 0), 0),
      pages: pages.length,
      blocks: blocks.length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

interface DescribeContext {
  topic: string;
  engine: ContentEngine;
  media: MediaCollector;
  imageSource: ImageSource | null;
}

async function describeProduct(
  product: MagentoProduct,
  ctx: DescribeContext
): Promise<void> {
  const seed = hashString(`${product.key}|${ctx.topic}`);

  // Seeds may already carry copy the design showed; never overwrite it.
  if (!product.description) {
    const blocks = await ctx.engine.generateBody({
      title: product.name,
      topic: ctx.topic,
      // A product description is a paragraph or three, not an article. Luma's
      // own run to roughly 60 words plus a short feature list.
      targetWords: 120,
      seed,
    });
    product.description = blocksToMagentoHtml(blocks.filter((b) => b.type !== 'image'));
  }

  if (!product.short_description) {
    product.short_description = await ctx.engine.generateExcerpt(
      product.name,
      ctx.topic,
      seed
    );
  }

  if (ctx.imageSource) {
    const path = await addImage(
      ctx.media,
      ctx.imageSource,
      `${product.name} ${ctx.topic}`,
      product.key,
      'feature'
    );
    if (path) product.image = path;

    // A second shot only on configurables: a swatch change wants something to
    // change to, and a one-image gallery renders as no gallery at all.
    if (product.type === 'configurable') {
      const alt = await addImage(
        ctx.media,
        ctx.imageSource,
        `${product.name} ${ctx.topic} detail`,
        `${product.key}-2`,
        'gallery'
      );
      if (alt) product.gallery = [alt];
    }
  }
}

// ---------------------------------------------------------------------------
// CMS
// ---------------------------------------------------------------------------

async function buildPages(
  request: MagentoContentRequest,
  engine: ContentEngine,
  warnings: string[]
): Promise<MagentoCmsPage[]> {
  const pages: MagentoCmsPage[] = [];

  for (const requested of request.pages ?? []) {
    const seed = hashString(`${request.theme}|page|${requested.key}`);
    const blocks = await engine.generateBody({
      title: requested.title,
      topic: request.store.topic,
      targetWords: 320,
      seed,
    });

    const body = blocksToMagentoHtml(blocks.filter((b) => b.type !== 'image'));
    pages.push({
      key: requested.key,
      title: requested.title,
      content_heading: requested.title,
      page_layout: requested.page_layout ?? '1column',
      // The wrapper class is Luma's own, so a theme styling `.cms-content`
      // dresses a generated page the same way it dresses the stock one.
      content: `<div class="cms-content">\n${body}\n</div>`,
    });
  }

  if ((request.pages?.length ?? 0) === 0) {
    warnings.push(
      'The request named no CMS pages, so footer links will have nothing to open'
    );
  }

  return pages;
}

/**
 * CMS blocks. Only the ones the request asked for, and only in shapes a block
 * can actually hold: a footer link list and a category menu are what Luma's
 * own `footer_links_block` and `*-left-menu-block` are.
 */
function buildBlocks(
  request: MagentoContentRequest,
  categories: MagentoCategory[]
): MagentoCmsBlock[] {
  const blocks: MagentoCmsBlock[] = [];

  for (const requested of request.blocks ?? []) {
    const content = /footer|links/i.test(requested.key)
      ? footerLinks(request)
      : /menu|nav|categor/i.test(requested.key)
        ? categoryMenu(requested.title, categories)
        : `<div class="block-content"><p>${escapeHtml(request.store.name)}</p></div>`;

    blocks.push({ key: requested.key, title: requested.title, content });
  }

  return blocks;
}

function footerLinks(request: MagentoContentRequest): string {
  const items = (request.pages ?? [])
    .map(
      (page) =>
        `    <li class="nav item"><a href="${storeUrl(page.key)}">${escapeHtml(page.title)}</a></li>`
    )
    .join('\n');
  return `<ul class="footer links">\n${items}\n</ul>\n`;
}

function categoryMenu(title: string, categories: MagentoCategory[]): string {
  const items = categories
    .map(
      (category) =>
        `    <li class="item"><a href="${storeUrl(category.url_key ?? category.key)}">${escapeHtml(category.name)}</a></li>`
    )
    .join('\n');
  return (
    `<div class="categories-menu"><strong class="title"><span>${escapeHtml(title)}</span></strong>\n` +
    `<ul class="items">\n${items}\n</ul>\n</div>\n`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function addImage(
  media: MediaCollector,
  source: ImageSource,
  query: string,
  baseName: string,
  role: 'feature' | 'gallery'
): Promise<string | undefined> {
  const refs = await source.fetch(
    {
      query,
      role,
      // Magento's catalog grid is square by convention (`etc/view.xml` ships
      // 1:1 for the product grid), and a landscape photo in a square tile is
      // cropped by the theme rather than by us.
      orientation: 'square',
      aspectRatio: 1,
      minWidth: 800,
    },
    1
  );
  // A source may return fewer than asked for; a missing image is never fatal.
  const ref = refs[0];
  if (!ref) return undefined;
  return media.add(ref, baseName);
}

function flatten(categories: MagentoCategory[]): MagentoCategory[] {
  const out: MagentoCategory[] = [];
  const walk = (list: MagentoCategory[]): void => {
    for (const category of list) {
      out.push(category);
      if (category.children) walk(category.children);
    }
  };
  walk(categories);
  return out;
}

// `seededRandom` is re-exported so tests can build a deterministic fixture
// without reaching into the image module for it.
export { seededRandom };
