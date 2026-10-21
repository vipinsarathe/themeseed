import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  exportMagentoDemo,
  MagentoDemoUsageError,
} from '../../src/providers/magento/index.js';
import { validateMagentoContent } from '../../src/providers/magento/validate.js';
import {
  blocksToMagentoHtml,
  encodeConditions,
  storeUrl,
  widget,
} from '../../src/providers/magento/directives.js';
import { planCatalog } from '../../src/providers/magento/catalog.js';
import type {
  MagentoContent,
  MagentoContentRequest,
} from '../../src/providers/magento/types.js';

const dirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-magento-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function request(overrides: Partial<MagentoContentRequest> = {}): MagentoContentRequest {
  return {
    format: 'magento-content-request/1',
    theme: 'aurelia-living',
    store: {
      name: 'Aurelia Living',
      topic: 'mid-century furniture and home decor',
      price_range: { min: 60, max: 2400 },
    },
    images: { source: 'none' },
    catalog: {
      departments: [
        {
          key: 'seating',
          name: 'Seating',
          children: [
            { key: 'sofas', name: 'Sofas' },
            { key: 'lounge-chairs', name: 'Lounge chairs' },
          ],
        },
        { key: 'tables', name: 'Tables' },
      ],
      products_per_leaf: 3,
      configurable_ratio: 1,
    },
    pages: [{ key: 'about-us', title: 'About us' }],
    blocks: [{ key: 'footer_links_block', title: 'Footer Links Block' }],
    ...overrides,
  };
}

async function run(
  req: MagentoContentRequest = request()
): Promise<{
  content: MagentoContent;
  outDir: string;
  report: Awaited<ReturnType<typeof exportMagentoDemo>>;
}> {
  const root = await tmp();
  const outDir = path.join(root, 'demo');
  const report = await exportMagentoDemo({
    request: req as unknown as Record<string, unknown>,
    outDir,
    creditsPath: path.join(root, 'credits.json'),
  });
  const content = JSON.parse(
    await fs.readFile(path.join(outDir, 'catalog.json'), 'utf8')
  ) as MagentoContent;
  return { content, outDir, report };
}

describe('magento-demo export', () => {
  it('writes a valid magento-content/1 package', async () => {
    const { content, report } = await run();

    expect(content.format).toBe('magento-content/1');
    expect(content.theme).toBe('aurelia-living');
    expect(validateMagentoContent(content)).toEqual([]);
    expect(report.written).toContain('catalog.json');
  });

  it('nests the category tree rather than flattening it', async () => {
    const { content } = await run();

    const seating = content.categories.find((c) => c.key === 'seating');
    expect(seating?.children?.map((c) => c.key)).toEqual(['sofas', 'lounge-chairs']);
    // A department with children is a landing page as well as a grid.
    expect(seating?.display_mode).toBe('PRODUCTS_AND_PAGE');
    expect(content.categories.find((c) => c.key === 'tables')?.display_mode).toBe(
      'PRODUCTS'
    );
  });

  it('attaches products to leaf categories, not to the parent', async () => {
    const { content } = await run();

    // 2 leaves under Seating + Tables as its own leaf = 3 leaves x 3 each.
    expect(content.products).toHaveLength(9);
    for (const product of content.products) {
      expect(product.categories).toHaveLength(1);
      expect(['sofas', 'lounge-chairs', 'tables']).toContain(product.categories![0]);
    }
  });

  it('gives every configurable axis the global select shape Magento demands', async () => {
    const { content } = await run();

    const configurable = content.products.filter((p) => p.type === 'configurable');
    expect(configurable.length).toBeGreaterThan(0);

    for (const product of configurable) {
      for (const code of product.axes!) {
        const attribute = content.attributes!.find((a) => a.code === code)!;
        // Magento refuses a non-global or non-select axis outright.
        expect(attribute.global).toBe(true);
        expect(attribute.input).toBe('select');
      }
    }
  });

  it('puts axis values on variants and never on the configurable parent', async () => {
    const { content } = await run();

    for (const product of content.products) {
      if (product.type !== 'configurable') continue;
      for (const code of product.axes!) {
        expect(product.attributes?.[code]).toBeUndefined();
      }
      for (const variant of product.variants!) {
        for (const code of product.axes!) {
          expect(variant.values[code]).toBeTruthy();
        }
      }
    }
  });

  it('keeps variant combinations distinct and SKUs unique across the package', async () => {
    const { content } = await run();

    const skus = new Set<string>();
    for (const product of content.products) {
      expect(skus.has(product.sku)).toBe(false);
      skus.add(product.sku);

      const combinations = new Set<string>();
      for (const variant of product.variants ?? []) {
        expect(skus.has(variant.sku)).toBe(false);
        skus.add(variant.sku);

        const signature = product.axes!.map((code) => variant.values[code]).join('|');
        expect(combinations.has(signature)).toBe(false);
        combinations.add(signature);
      }
    }
  });

  it('gives a simple product a weight and a configurable parent none', async () => {
    const { content } = await run(
      request({
        catalog: { ...request().catalog, configurable_ratio: 0 },
      })
    );

    for (const product of content.products) {
      expect(product.type).toBe('simple');
      expect(product.weight).toBeTruthy();
      expect(product.variants).toBeUndefined();
    }
  });

  it('is deterministic: the same request regenerates the same package', async () => {
    const first = await run();
    const second = await run();

    // generator carries the version, which is stable within a run.
    expect(JSON.stringify(second.content)).toBe(JSON.stringify(first.content));
  });

  it('keeps seeds verbatim', async () => {
    const { content } = await run(
      request({
        catalog: {
          ...request().catalog,
          seeds: [
            {
              key: 'halden-sofa',
              name: 'Halden Three-Seat Sofa',
              category: 'sofas',
              price: '1890.00',
              type: 'simple',
              sku: 'AL-HALDEN',
            },
          ],
        },
      })
    );

    const seeded = content.products.find((p) => p.key === 'halden-sofa');
    expect(seeded?.name).toBe('Halden Three-Seat Sofa');
    expect(seeded?.price).toBe('1890.00');
    expect(seeded?.sku).toBe('AL-HALDEN');
    expect(seeded?.categories).toEqual(['sofas']);
  });

  it('writes CMS content as directives, never absolute URLs', async () => {
    const { content } = await run();

    const block = content.blocks!.find((b) => b.key === 'footer_links_block')!;
    expect(block.content).toContain('{{store url="about-us"}}');
    expect(block.content).not.toMatch(/https?:\/\//);

    for (const page of content.pages ?? []) {
      expect(page.content).not.toMatch(/<script/i);
      expect(page.content).not.toMatch(/data-content-type/);
    }
  });

  it('replaces catalog.json and content-media/ without touching anything else', async () => {
    const root = await tmp();
    const outDir = path.join(root, 'demo');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'manifest.json'), '{"keep":true}');

    await exportMagentoDemo({
      request: request() as unknown as Record<string, unknown>,
      outDir,
      creditsPath: path.join(root, 'credits.json'),
    });

    expect(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8')).toBe(
      '{"keep":true}'
    );
  });

  it('refuses a credits path inside the theme folder', async () => {
    const root = await tmp();
    const outDir = path.join(root, 'demo');

    await expect(
      exportMagentoDemo({
        request: request() as unknown as Record<string, unknown>,
        outDir,
        creditsPath: path.join(outDir, 'credits.json'),
      })
    ).rejects.toThrow(/would ship in the theme zip/);
  });

  it('refuses a seed naming a category that does not exist', async () => {
    await expect(
      run(
        request({
          catalog: {
            ...request().catalog,
            seeds: [{ key: 'ghost', name: 'Ghost Chair', category: 'nowhere' }],
          },
        })
      )
    ).rejects.toThrow(MagentoDemoUsageError);
  });

  it('refuses a request that is not the right format', async () => {
    const root = await tmp();
    await expect(
      exportMagentoDemo({
        request: { format: 'nic-content-request/1' } as Record<string, unknown>,
        outDir: path.join(root, 'demo'),
        creditsPath: path.join(root, 'credits.json'),
      })
    ).rejects.toThrow(MagentoDemoUsageError);
  });
});

describe('magento validation', () => {
  function pkg(overrides: Partial<MagentoContent> = {}): MagentoContent {
    return {
      format: 'magento-content/1',
      generator: 'themeseed@test',
      theme: 'demo',
      attributes: [
        {
          code: 'color',
          label: 'Colour',
          input: 'select',
          global: true,
          options: [
            { key: 'black', label: 'Black' },
            { key: 'blue', label: 'Blue' },
          ],
        },
      ],
      attribute_sets: [{ key: 'default', name: 'Default', attributes: ['color'] }],
      categories: [{ key: 'chairs', name: 'Chairs' }],
      products: [
        {
          key: 'one',
          sku: 'A-1',
          type: 'simple',
          name: 'One',
          price: '10.00',
          categories: ['chairs'],
        },
      ],
      ...overrides,
    };
  }

  it('accepts a minimal valid package', () => {
    expect(validateMagentoContent(pkg())).toEqual([]);
  });

  it('rejects a non-global configurable axis', () => {
    const problems = validateMagentoContent(
      pkg({
        attributes: [
          {
            code: 'color',
            label: 'Colour',
            input: 'select',
            global: false,
            options: [{ key: 'black', label: 'Black' }],
          },
        ],
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'configurable',
            name: 'One',
            price: '10.00',
            axes: ['color'],
            variants: [{ sku: 'A-1-BLACK', price: '10.00', values: { color: 'black' } }],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/must be global:true/);
  });

  it('rejects a variant whose option does not exist', () => {
    const problems = validateMagentoContent(
      pkg({
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'configurable',
            name: 'One',
            price: '10.00',
            axes: ['color'],
            variants: [{ sku: 'A-1-PINK', price: '10.00', values: { color: 'pink' } }],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/has no option "pink"/);
  });

  it('rejects two variants sharing a combination', () => {
    const problems = validateMagentoContent(
      pkg({
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'configurable',
            name: 'One',
            price: '10.00',
            axes: ['color'],
            variants: [
              { sku: 'A-1-B1', price: '10.00', values: { color: 'black' } },
              { sku: 'A-1-B2', price: '10.00', values: { color: 'black' } },
            ],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/share the combination/);
  });

  it('rejects a duplicate SKU across a product and a variant', () => {
    const problems = validateMagentoContent(
      pkg({
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'configurable',
            name: 'One',
            price: '10.00',
            axes: ['color'],
            variants: [{ sku: 'A-1', price: '10.00', values: { color: 'black' } }],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/already used/);
  });

  it('rejects a special price that is not a discount', () => {
    const problems = validateMagentoContent(
      pkg({
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'simple',
            name: 'One',
            price: '10.00',
            special_price: '12.00',
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/not less than price/);
  });

  it('rejects an unknown category reference', () => {
    const problems = validateMagentoContent(
      pkg({
        products: [
          {
            key: 'one',
            sku: 'A-1',
            type: 'simple',
            name: 'One',
            price: '10.00',
            categories: ['nowhere'],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/unknown category "nowhere"/);
  });

  it('rejects script and absolute URLs in CMS content', () => {
    const problems = validateMagentoContent(
      pkg({
        pages: [
          { key: 'a', title: 'A', content: '<script>alert(1)</script>' },
          { key: 'b', title: 'B', content: '<a href="https://example.com/about">x</a>' },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/<script>/);
    expect(problems.join(' ')).toMatch(/absolute URL/);
  });

  it('rejects a category tree deeper than Magento breadcrumbs handle', () => {
    const problems = validateMagentoContent(
      pkg({
        categories: [
          {
            key: 'a',
            name: 'A',
            children: [
              {
                key: 'b',
                name: 'B',
                children: [
                  {
                    key: 'c',
                    name: 'C',
                    children: [
                      { key: 'd', name: 'D', children: [{ key: 'e', name: 'E' }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(problems.join(' ')).toMatch(/nests deeper than 4 levels/);
  });
});

describe('magento directives', () => {
  it('strips a leading slash from a store url', () => {
    expect(storeUrl('/about-us')).toBe('{{store url="about-us"}}');
    expect(storeUrl('')).toBe('{{store url=""}}');
  });

  it('renders blocks as plain HTML, not Page Builder markup', () => {
    const html = blocksToMagentoHtml([
      { type: 'heading', level: 2, text: 'About' },
      { type: 'paragraph', text: 'Hello & welcome' },
      { type: 'list', ordered: false, items: ['One', 'Two'] },
    ]);

    expect(html).toContain('<h2>About</h2>');
    expect(html).toContain('<p>Hello &amp; welcome</p>');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(html).not.toContain('data-content-type');
  });

  it('drops an image block when nothing resolves it', () => {
    const html = blocksToMagentoHtml([
      { type: 'image', image: { kind: 'url', location: 'https://x/y.jpg' } },
      { type: 'paragraph', text: 'Still here' },
    ]);
    expect(html).toBe('<p>Still here</p>');
  });

  it('encodes widget conditions in Magento’s own alphabet', () => {
    const encoded = encodeConditions([
      { attribute: 'sku', operator: '()', value: '24-MB01, 24-WB04' },
    ]);

    // `[` -> `^[`, `"` -> backtick, `\` -> `||`
    expect(encoded).toContain('^[');
    expect(encoded).not.toContain('"');
    expect(encoded).toContain('Magento||CatalogWidget||Model||Rule||Condition||Product');
    expect(encoded).toContain('`attribute`:`sku`');
  });

  it('builds a products-list widget directive', () => {
    const directive = widget(
      'Magento\\CatalogWidget\\Block\\Product\\ProductsList',
      { products_count: '5', template: 'product/widget/content/grid.phtml' },
      [{ attribute: 'sku', operator: '()', value: 'A-1' }]
    );

    expect(directive.startsWith('{{widget type="Magento\\CatalogWidget')).toBe(true);
    expect(directive).toContain('products_count="5"');
    expect(directive).toContain('conditions_encoded="');
    expect(directive.endsWith('}}')).toBe(true);
  });
});

describe('magento catalog planning', () => {
  it('treats a childless department as its own leaf', () => {
    const plan = planCatalog(
      request({
        catalog: {
          departments: [
            { key: 'a', name: 'Alpha' },
            { key: 'b', name: 'Beta' },
          ],
          products_per_leaf: 2,
          configurable_ratio: 0,
        },
      })
    );

    expect(plan.products).toHaveLength(4);
    expect(plan.categories.every((c) => !c.children)).toBe(true);
  });

  it('emits no axis attributes when nothing is configurable', () => {
    const plan = planCatalog(
      request({ catalog: { ...request().catalog, configurable_ratio: 0 } })
    );

    expect(plan.attributes.map((a) => a.code)).toEqual(['material']);
    expect(plan.products.every((p) => p.type === 'simple')).toBe(true);
  });

  it('names products after the thing the category holds', () => {
    const plan = planCatalog(
      request({
        catalog: {
          departments: [{ key: 'sofas', name: 'Sofas' }],
          products_per_leaf: 2,
          configurable_ratio: 0,
        },
      })
    );

    // "Sofas" -> "Sofa": a product is one of the thing the category holds.
    for (const product of plan.products) {
      expect(product.name).toMatch(/ Sofa$/);
    }
  });

  it('gives every department its own attribute set', () => {
    const plan = planCatalog(request());
    expect(plan.attributeSets.map((s) => s.key)).toEqual(['seating', 'tables']);
  });

  it('sizes a sofa by seat count and a shirt by letter', () => {
    const labels = (topic: string): string[] => {
      const plan = planCatalog(request({ store: { name: 'S', topic } }));
      return plan.attributes.find((a) => a.code === 'size')!.options!.map((o) => o.label);
    };

    // "Nessa Sofa, size XS" is structurally valid and visibly wrong, which is
    // the whole reason the scale is chosen per topic.
    expect(labels('mid-century furniture and home decor')).toContain('Three-seat');
    expect(labels('performance activewear')).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(labels('single origin coffee roastery')).toContain('500 g');
  });

  it('weighs a sofa in tens of kilos and a ring in grams', () => {
    const weight = (topic: string): number => {
      const plan = planCatalog(
        request({
          store: { name: 'S', topic },
          catalog: { ...request().catalog, configurable_ratio: 0 },
        })
      );
      return Number(plan.products[0]!.weight);
    };

    expect(weight('mid-century furniture and home decor')).toBeGreaterThan(8);
    expect(weight('handmade jewellery and rings')).toBeLessThan(1);
  });
});
