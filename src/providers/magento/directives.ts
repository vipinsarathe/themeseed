/**
 * Converts the platform-neutral block model into what Magento's CMS actually
 * stores: plain HTML carrying Magento's own template directives.
 *
 * This is the Magento-specific half of rule 2 in the architecture — the
 * sibling of ghost/lexical.ts and wordpress/gutenberg.ts. Nothing outside this
 * directory produces or sees a `{{store url}}`.
 *
 * Why plain HTML rather than Page Builder markup
 * ----------------------------------------------
 * Measured, not assumed. Across a full Magento 2.4 database with Luma sample
 * data (2,040 products, 392 CMS blocks, 22 pages), the directive counts are:
 *
 *     {{store url="…"}}       110
 *     {{media url="…"}}        38
 *     {{block …}}              33
 *     {{widget type="…"}}      15
 *     data-content-type         1   ← and that one is a hand-written attribute
 *                                      on a ported page, not real PB markup
 *
 * So Luma — the content every stock install ships and every theme is built
 * against — is escaped HTML plus directives. Emitting Page Builder markup
 * would produce content the stock admin cannot edit and most themes do not
 * style.
 *
 * Two rules the dump makes non-negotiable:
 *
 * - **Internal links are `{{store url="…"}}`, never absolute.** The dump has
 *   `http://localhost:8090/catalogsearch/...` baked into a stock CMS block,
 *   which is dead on every other host. The directive resolves against the
 *   store's own base URL at render time.
 * - **Images in a CMS body reference `content-media/` paths**, which the data
 *   patch rewrites to the media URL it sideloaded them to. A remote `<img>`
 *   in CMS content is rejected by validation.
 *
 * Pure: no network, no filesystem.
 */

import type { ContentBlock, ImageRef } from '../../core/types.js';

/** Maps a neutral image ref to its `content-media/…` path, when it has one. */
export type MediaResolver = (ref: ImageRef) => string | undefined;

/** Resolves nothing: image blocks are dropped, the prose still renders. */
export const resolveNoMedia: MediaResolver = () => undefined;

export function blocksToMagentoHtml(
  blocks: ContentBlock[],
  resolve: MediaResolver = resolveNoMedia
): string {
  const rendered: string[] = [];
  for (const block of blocks) {
    const html = blockToHtml(block, resolve);
    if (html) rendered.push(html);
  }
  return rendered.join('\n');
}

function blockToHtml(block: ContentBlock, resolve: MediaResolver): string {
  switch (block.type) {
    case 'paragraph':
      return block.text.trim() ? `<p>${escapeHtml(block.text)}</p>` : '';

    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;

    case 'image': {
      const path = resolve(block.image);
      if (!path) return '';
      const alt = block.alt ?? block.image.alt ?? '';
      const img = `<img src="${escapeAttr(path)}" alt="${escapeAttr(alt)}" />`;
      // Magento's own CMS content wraps a captioned image in a figure; without
      // a caption the bare img is what Luma's blocks contain.
      return block.caption
        ? `<figure>${img}<figcaption>${escapeHtml(block.caption)}</figcaption></figure>`
        : img;
    }

    case 'gallery': {
      const items = block.images
        .map((ref) => resolve(ref))
        .filter((path): path is string => !!path)
        .map((path) => `<li class="item"><img src="${escapeAttr(path)}" alt="" /></li>`);
      if (items.length === 0) return '';
      return `<ul class="gallery items">${items.join('')}</ul>`;
    }

    case 'quote':
      return block.attribution
        ? `<blockquote><p>${escapeHtml(block.text)}</p><cite>${escapeHtml(block.attribution)}</cite></blockquote>`
        : `<blockquote><p>${escapeHtml(block.text)}</p></blockquote>`;

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }

    case 'code':
      return `<pre><code>${escapeHtml(block.code)}</code></pre>`;

    case 'divider':
      return '<hr />';

    case 'video':
      // A CMS body is not a product page; an iframe here is the one place a
      // remote embed is both expected and safe, but the contract forbids
      // <script> and the stock WYSIWYG strips iframes from saved content.
      // Dropping it loses nothing a theme would have styled.
      return '';

    default: {
      // Exhaustiveness: a new ContentBlock type must be handled here, not
      // silently rendered as nothing.
      const never: never = block;
      void never;
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/**
 * `{{store url="about-us"}}` — a link to one of the store's own routes.
 *
 * Pass the route without a leading slash, exactly as Luma's own blocks do
 * (`{{store url="customer-service"}}`). The empty string is the home page.
 */
export function storeUrl(route: string): string {
  return `{{store url="${route.replace(/^\/+/, '')}"}}`;
}

/** `{{media url="wysiwyg/…"}}` — a file under `pub/media`. */
export function mediaUrl(path: string): string {
  return `{{media url="${path.replace(/^\/+/, '')}"}}`;
}

/**
 * A `{{widget}}` call, with its parameters escaped the way Magento expects.
 *
 * Only `conditions_encoded` needs the odd escaping; every other parameter is a
 * plain string. Callers pass raw values and this applies the encoding, because
 * getting it wrong produces a widget that renders nothing with no error.
 */
export function widget(
  type: string,
  params: Record<string, string>,
  conditions?: WidgetCondition[]
): string {
  const parts = [`type="${type}"`];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${key}="${value}"`);
  }
  if (conditions?.length) {
    parts.push(`conditions_encoded="${encodeConditions(conditions)}"`);
  }
  return `{{widget ${parts.join(' ')}}}`;
}

export interface WidgetCondition {
  /** Product attribute code, e.g. `sku` or `eco_collection`. */
  attribute: string;
  /** Magento's rule operator: `==`, `()` for "is one of", `>=` and so on. */
  operator: string;
  value: string;
}

/**
 * Magento's rule-condition escaping, taken from the strings in a real
 * `cms_block.content`:
 *
 *     [  →  ^[        "  →  `        \  →  ||
 *
 * The structure is the serialized form of a `Rule\Condition\Combine` holding
 * one `Rule\Condition\Product` per condition, keyed `1--1`, `1--2`, …
 */
export function encodeConditions(conditions: WidgetCondition[]): string {
  // Written directly in the encoded alphabet rather than built as JSON and
  // escaped afterwards: the escaping is not reversible in one pass (a literal
  // backtick in a value would be indistinguishable from a quote), and every
  // value that reaches here is an attribute code or a SKU list.
  const cls = (name: string): string =>
    `Magento||CatalogWidget||Model||Rule||Condition||${name}`;

  const combine =
    `^[\`type\`:\`${cls('Combine')}\`,` +
    '`aggregator`:`all`,`value`:`1`,`new_child`:``^]';

  const children = conditions.map((condition, index) => {
    const body =
      `^[\`type\`:\`${cls('Product')}\`,` +
      `\`attribute\`:\`${condition.attribute}\`,` +
      `\`operator\`:\`${condition.operator}\`,` +
      `\`value\`:\`${condition.value}\`^]`;
    return `\`1--${index + 1}\`:${body}`;
  });

  return `^[\`1\`:${combine}` + (children.length ? `,${children.join(',')}` : '') + '^]';
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
