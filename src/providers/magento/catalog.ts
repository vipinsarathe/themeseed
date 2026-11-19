/**
 * Turning a request's nouns into a Magento-shaped catalog: the attributes, the
 * attribute sets, the nested category tree, and the products — simple and
 * configurable — that hang off it.
 *
 * Shaped after how Luma actually stores a storefront, because that is the
 * catalog every Magento theme is designed against:
 *
 * - A **configurable parent** carries price and no axis values and is visible
 *   in catalog and search; each **child** carries the axis values, its own
 *   price and weight, and is not visible individually. Getting that backwards
 *   produces a storefront where every size of every shirt is a separate tile.
 * - An **axis attribute must be global and a select.** Magento refuses
 *   anything else, and the refusal surfaces as an exception inside
 *   `setup:upgrade` rather than as anything a merchant can read.
 * - **Attribute sets group the attributes a department needs.** Luma has seven
 *   (Top, Bottom, Gear, Bag, …) rather than putting every attribute on every
 *   product.
 *
 * Deterministic: the same request regenerates the same catalog, because a
 * demo package that changes on every run cannot be diffed or reviewed.
 */

import { slugify } from '../../content/generator.js';
import { hashString } from '../../content/engine.js';
import { seededRandom } from '../../images/png.js';
import {
  DEFAULT_CONFIGURABLE_RATIO,
  DEFAULT_PRICE_RANGE,
  DEFAULT_PRODUCTS_PER_LEAF,
  type MagentoAttribute,
  type MagentoAttributeOption,
  type MagentoAttributeSet,
  type MagentoCategory,
  type MagentoContentRequest,
  type MagentoProduct,
  type MagentoVariant,
} from './types.js';

type Random = () => number;

export interface CatalogPlan {
  attributes: MagentoAttribute[];
  attributeSets: MagentoAttributeSet[];
  categories: MagentoCategory[];
  products: MagentoProduct[];
  warnings: string[];
}

/** One leaf category a product can be attached to, with its department. */
interface Leaf {
  key: string;
  name: string;
  /** The top-level department this leaf sits under; the attribute set follows it. */
  departmentKey: string;
}

// ---------------------------------------------------------------------------
// Axis vocabulary
// ---------------------------------------------------------------------------

/**
 * Colour options with their swatch hexes, taken from Luma's own
 * `eav_attribute_option_swatch` rows so a generated storefront's swatch strip
 * looks like the one every Magento theme was designed against.
 */
const COLOURS: ReadonlyArray<{ key: string; label: string; swatch: string }> = [
  { key: 'black', label: 'Black', swatch: '#000000' },
  { key: 'blue', label: 'Blue', swatch: '#1857f7' },
  { key: 'brown', label: 'Brown', swatch: '#945454' },
  { key: 'grey', label: 'Grey', swatch: '#8f8f8f' },
  { key: 'green', label: 'Green', swatch: '#53a828' },
  { key: 'white', label: 'White', swatch: '#ffffff' },
  { key: 'orange', label: 'Orange', swatch: '#eb6703' },
  { key: 'red', label: 'Red', swatch: '#d8102a' },
];

/**
 * Size options, picked for the business rather than fixed.
 *
 * Apparel letter sizes on a sofa — "Nessa Sofa, size XS" — is the kind of
 * claim `quick-content.ts` was written to avoid: structurally valid, visibly
 * wrong to anyone reading the storefront. Luma itself keeps three separate
 * size vocabularies for exactly this reason (apparel XS–XL, waist 28–38, and
 * gear "55 cm"/"6 foot"), stored as different option-id ranges on one
 * attribute.
 */
interface TopicProfile {
  match?: RegExp;
  /**
   * What the size axis is called here. "Size: 250 g" reads as a mistake on a
   * bag of coffee; the scale was already right, only the word was borrowed
   * from apparel.
   */
  sizeLabel: string;
  sizes: ReadonlyArray<{ key: string; label: string }>;
  /**
   * Non-axis attributes this trade actually filters on. These are what fills
   * layered navigation beyond colour and size, so they are the difference
   * between a demo storefront that looks shoppable and one that does not —
   * and reusing Luma's own vocabulary everywhere is how a coffee shop ended up
   * offering Cotton, Leather and Wool.
   */
  facets: ReadonlyArray<{
    code: string;
    label: string;
    input: 'select' | 'multiselect';
    values: readonly string[];
  }>;
}

const TOPIC_PROFILES: readonly TopicProfile[] = [
  {
    match:
      /\b(furniture|sofa|seating|interior|home decor|homeware|decor|lighting|lamp)\b/i,
    sizeLabel: 'Size',
    sizes: [
      { key: 'two-seat', label: 'Two-seat' },
      { key: 'three-seat', label: 'Three-seat' },
      { key: 'compact', label: 'Compact' },
      { key: 'wide', label: 'Wide' },
    ],
    facets: [
      {
        code: 'material',
        label: 'Material',
        input: 'multiselect',
        values: ['Oak', 'Walnut', 'Teak', 'Linen', 'Leather', 'Steel', 'Glass', 'Marble'],
      },
      {
        code: 'room',
        label: 'Room',
        input: 'select',
        values: ['Living room', 'Dining room', 'Bedroom', 'Study', 'Outdoor'],
      },
    ],
  },
  {
    match: /\b(coffee|tea|food|grocer\w*|spice|snack|bakery|roaster\w*)\b/i,
    sizeLabel: 'Pack size',
    sizes: [
      { key: '250g', label: '250 g' },
      { key: '500g', label: '500 g' },
      { key: '1kg', label: '1 kg' },
    ],
    facets: [
      {
        code: 'roast_level',
        label: 'Roast level',
        input: 'select',
        values: ['Light', 'Medium', 'Medium-dark', 'Dark'],
      },
      {
        code: 'origin',
        label: 'Origin',
        input: 'select',
        values: ['Ethiopia', 'Colombia', 'Brazil', 'Guatemala', 'Kenya', 'Sumatra'],
      },
      {
        code: 'grind',
        label: 'Grind',
        input: 'multiselect',
        values: ['Whole bean', 'Espresso', 'Filter', 'French press', 'Moka pot'],
      },
    ],
  },
  {
    match: /\b(jewel\w*|ring|watch|accessor\w*)\b/i,
    sizeLabel: 'Length',
    sizes: [
      { key: '16cm', label: '16 cm' },
      { key: '18cm', label: '18 cm' },
      { key: '20cm', label: '20 cm' },
    ],
    facets: [
      {
        code: 'material',
        label: 'Material',
        input: 'multiselect',
        values: ['Sterling silver', '18ct gold', 'Rose gold', 'Platinum', 'Brass'],
      },
      {
        code: 'gemstone',
        label: 'Gemstone',
        input: 'select',
        values: ['None', 'Diamond', 'Sapphire', 'Emerald', 'Opal'],
      },
    ],
  },
  // Apparel, and the fallback for a topic that names nothing else.
  {
    sizeLabel: 'Size',
    sizes: [
      { key: 'xs', label: 'XS' },
      { key: 's', label: 'S' },
      { key: 'm', label: 'M' },
      { key: 'l', label: 'L' },
      { key: 'xl', label: 'XL' },
    ],
    facets: [
      {
        code: 'material',
        label: 'Material',
        input: 'multiselect',
        values: ['Cotton', 'Linen', 'Wool', 'Leather', 'Denim', 'Silk'],
      },
      {
        code: 'style',
        label: 'Style',
        input: 'select',
        values: ['Casual', 'Formal', 'Sport', 'Outdoor'],
      },
    ],
  },
];

function profileFor(topic: string): TopicProfile {
  // The last entry has no `match` and is the fallback, so this never misses.
  return TOPIC_PROFILES.find((profile) => !profile.match || profile.match.test(topic))!;
}

/**
 * Weight range in kilograms, by topic. A 3.8 kg sofa reads as a typo; so does
 * a 40 kg t-shirt. Magento needs *a* weight on every simple product and every
 * variant, so the only choice is which range it comes from.
 */
function weightRangeFor(topic: string): [number, number] {
  if (/\b(furniture|sofa|seating|table|interior|home decor|homeware)\b/i.test(topic))
    return [8, 45];
  if (/\b(lighting|lamp|decor)\b/i.test(topic)) return [1, 8];
  if (/\b(jewel\w*|ring|watch|accessor\w*)\b/i.test(topic)) return [0.05, 0.5];
  return [0.2, 3];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function planCatalog(request: MagentoContentRequest): CatalogPlan {
  const warnings: string[] = [];
  const random = seededRandom(hashString(`${request.theme}|${request.store.topic}`));

  const { categories, leaves } = planCategories(request);
  const attributes = planAttributes(request);
  const attributeSets = planAttributeSets(request, attributes);
  const products = planProducts(request, leaves, attributes, random, warnings);

  return { attributes, attributeSets, categories, products, warnings };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function planCategories(request: MagentoContentRequest): {
  categories: MagentoCategory[];
  leaves: Leaf[];
} {
  const categories: MagentoCategory[] = [];
  const leaves: Leaf[] = [];

  for (const department of request.catalog.departments) {
    const children = department.children ?? [];

    const node: MagentoCategory = {
      key: department.key,
      name: department.name,
      // A department with children is a landing page as well as a grid — that
      // is what PRODUCTS_AND_PAGE means, and what Luma sets on Gear.
      display_mode: children.length > 0 ? 'PRODUCTS_AND_PAGE' : 'PRODUCTS',
      ...(department.description ? { description: department.description } : {}),
    };

    if (children.length > 0) {
      node.children = children.map((child) => ({
        key: child.key,
        name: child.name,
        display_mode: 'PRODUCTS' as const,
        ...(child.description ? { description: child.description } : {}),
      }));
      for (const child of children) {
        leaves.push({ key: child.key, name: child.name, departmentKey: department.key });
      }
    } else {
      // A childless department is itself a leaf; products hang directly off it.
      leaves.push({
        key: department.key,
        name: department.name,
        departmentKey: department.key,
      });
    }

    categories.push(node);
  }

  return { categories, leaves };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function planAttributes(request: MagentoContentRequest): MagentoAttribute[] {
  const ratio = request.catalog.configurable_ratio ?? DEFAULT_CONFIGURABLE_RATIO;
  const profile = profileFor(request.store.topic);
  const attributes: MagentoAttribute[] = [];

  if (ratio > 0) {
    const axes = request.catalog.axes ?? [
      { code: 'color', label: 'Colour', swatch: 'visual' as const },
      { code: 'size', label: profile.sizeLabel, swatch: 'text' as const },
    ];

    for (const axis of axes) {
      const visual = axis.swatch === 'visual';
      const source: ReadonlyArray<{ key: string; label: string; swatch?: string }> =
        axis.code === 'size' ? profile.sizes : COLOURS;
      const options: MagentoAttributeOption[] = source.map((option) => ({
        key: option.key,
        label: option.label,
        ...(visual && option.swatch ? { swatch: option.swatch } : {}),
      }));
      attributes.push({
        code: axis.code,
        label: axis.label,
        input: 'select',
        // Both are required by Magento for a configurable axis; see the file
        // docblock. Not a default a caller may override.
        global: true,
        ...FILTERABLE,
        ...(axis.swatch ? { swatch: axis.swatch } : {}),
        options,
      });
    }
  }

  // The non-axis facets this trade filters on, so layered navigation has more
  // than colour and size in it.
  for (const facet of profile.facets) {
    attributes.push({
      code: facet.code,
      label: facet.label,
      input: facet.input,
      global: false,
      ...FILTERABLE,
      options: facet.values.map((name) => ({ key: slugify(name), label: name })),
    });
  }

  return attributes;
}

/**
 * Every generated attribute is filterable. A demo catalog exists to show a
 * storefront working, and Magento's default of 0 builds no facet at all — the
 * theme's filter sidebar then renders correctly with nothing in it, which is
 * the one failure that reads as a broken theme rather than a thin catalog.
 */
const FILTERABLE = {
  is_filterable: 1,
  is_filterable_in_search: 1,
} as const satisfies Pick<MagentoAttribute, 'is_filterable' | 'is_filterable_in_search'>;

function planAttributeSets(
  request: MagentoContentRequest,
  attributes: MagentoAttribute[]
): MagentoAttributeSet[] {
  const codes = attributes.map((attribute) => attribute.code);
  // One set per department, named for it. Luma's sets are per product family
  // (Top, Bottom, Bag) and departments are the closest thing a request has.
  return request.catalog.departments.map((department) => ({
    key: department.key,
    name: department.name,
    attributes: codes,
  }));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function planProducts(
  request: MagentoContentRequest,
  leaves: Leaf[],
  attributes: MagentoAttribute[],
  random: Random,
  warnings: string[]
): MagentoProduct[] {
  const perLeaf = request.catalog.products_per_leaf ?? DEFAULT_PRODUCTS_PER_LEAF;
  const ratio = request.catalog.configurable_ratio ?? DEFAULT_CONFIGURABLE_RATIO;
  const range = request.store.price_range ?? DEFAULT_PRICE_RANGE;
  const seeds = request.catalog.seeds ?? [];

  const axisCodes = attributes
    .filter((a) => a.global && a.input === 'select')
    .map((a) => a.code);
  const facets = attributes.filter(
    (a) => !axisCodes.includes(a.code) && (a.options?.length ?? 0) > 0
  );
  const weight = weightRangeFor(request.store.topic);

  const skuPrefix = skuStem(request.store.name);
  const usedKeys = new Set<string>();
  const usedSkus = new Set<string>();
  const products: MagentoProduct[] = [];

  // Seeds first and verbatim: they are the names the design actually shows,
  // and a generated substitute would contradict the page it sits on.
  for (const seed of seeds) {
    const leaf = leaves.find((candidate) => candidate.key === seed.category) ?? leaves[0];
    if (!leaf) break;
    products.push(
      buildProduct({
        key: seed.key,
        name: seed.name,
        leaf,
        type: seed.type ?? 'simple',
        price: seed.price ?? money(pickPrice(random, range)),
        sku: seed.sku ?? uniqueSku(skuPrefix, seed.name, usedSkus),
        axisCodes,
        attributes,
        facets,
        random,
        weight,
        ...(seed.description ? { description: seed.description } : {}),
        ...(seed.short_description ? { shortDescription: seed.short_description } : {}),
      })
    );
    usedKeys.add(seed.key);
  }

  for (const leaf of leaves) {
    const already = products.filter((product) =>
      product.categories?.includes(leaf.key)
    ).length;
    for (let index = already; index < perLeaf; index++) {
      const name = productName(leaf, index, random);
      const key = uniqueKey(slugify(name), usedKeys);
      const configurable = axisCodes.length > 0 && random() < ratio;

      products.push(
        buildProduct({
          key,
          name,
          leaf,
          type: configurable ? 'configurable' : 'simple',
          price: money(pickPrice(random, range)),
          sku: uniqueSku(skuPrefix, name, usedSkus),
          axisCodes,
          attributes,
          facets,
          random,
          weight,
        })
      );
    }
  }

  if (products.length === 0) {
    warnings.push(
      'No products were generated; check that the request names at least one department'
    );
  }

  return products;
}

interface BuildArgs {
  key: string;
  name: string;
  leaf: Leaf;
  type: 'simple' | 'configurable';
  price: string;
  sku: string;
  axisCodes: string[];
  attributes: MagentoAttribute[];
  /** The non-axis attributes this product should carry a value for. */
  facets: MagentoAttribute[];
  random: Random;
  /** Kilogram floor and ceiling for this topic; see weightRangeFor. */
  weight: [number, number];
  description?: string;
  shortDescription?: string;
}

function buildProduct(args: BuildArgs): MagentoProduct {
  const product: MagentoProduct = {
    key: args.key,
    sku: args.sku,
    type: args.type,
    attribute_set: args.leaf.departmentKey,
    name: args.name,
    url_key: slugify(args.name),
    price: args.price,
    categories: [args.leaf.key],
    ...(args.description ? { description: args.description } : {}),
    ...(args.shortDescription ? { short_description: args.shortDescription } : {}),
  };

  // Every non-axis facet gets a value, or the attribute exists with nothing
  // behind it and its filter shows up empty.
  const values: Record<string, string | string[]> = {};
  for (const facet of args.facets) {
    const options = facet.options ?? [];
    if (options.length === 0) continue;
    const chosen =
      facet.input === 'multiselect'
        ? pickSome(args.random, options, 1, 2).map((option) => option.key)
        : pickSome(args.random, options, 1, 1)[0]!.key;
    values[facet.code] = chosen;
  }
  if (Object.keys(values).length > 0) product.attributes = values;

  if (args.type === 'configurable' && args.axisCodes.length > 0) {
    product.axes = args.axisCodes;
    product.variants = buildVariants(args);
  } else {
    // Only a simple product carries its own weight; on a configurable the
    // weight belongs to each child, as it does throughout Luma.
    product.weight = weigh(args.random, args.weight);
  }

  return product;
}

function buildVariants(args: BuildArgs): MagentoVariant[] {
  const byCode = new Map(args.attributes.map((attribute) => [attribute.code, attribute]));

  // A subset per axis rather than the full cross product: Luma's hoodie is 5
  // sizes x 3 colours, not 5 x 12, because a demo wants a believable grid and
  // not 60 children per product.
  const chosen = args.axisCodes.map((code) => {
    const options = byCode.get(code)?.options ?? [];
    const take =
      code === 'size' ? Math.min(options.length, 3 + Math.floor(args.random() * 3)) : 3;
    return { code, options: pickSome(args.random, options, take, take) };
  });

  const combinations: Array<Record<string, string>> = [{}];
  for (const axis of chosen) {
    const next: Array<Record<string, string>> = [];
    for (const partial of combinations) {
      for (const option of axis.options)
        next.push({ ...partial, [axis.code]: option.key });
    }
    combinations.length = 0;
    combinations.push(...next);
  }

  const weight = weigh(args.random, args.weight);
  return combinations.map((values) => ({
    sku: `${args.sku}-${Object.values(values)
      .map((v) => v.toUpperCase())
      .join('-')}`.slice(0, 40),
    price: args.price,
    weight,
    values,
  }));
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Product names built from the leaf category's own noun rather than a fixed
 * bank: "Sofas" yields "Halden Sofa", not "Coastal Bundle". The adjectives are
 * place-neutral surnames, which is how furniture, apparel and homeware
 * catalogues actually name things.
 */
const NAME_STEMS = [
  'Halden',
  'Orla',
  'Marlow',
  'Brecon',
  'Alvar',
  'Nessa',
  'Rowan',
  'Teign',
  'Calder',
  'Ingrid',
  'Sorrel',
  'Fenwick',
  'Lundy',
  'Mirren',
  'Dalby',
  'Ashcombe',
] as const;

function productName(leaf: Leaf, index: number, random: Random): string {
  const stem =
    NAME_STEMS[(index + Math.floor(random() * NAME_STEMS.length)) % NAME_STEMS.length]!;
  // "Sofas" -> "Sofa": a product is one of the thing the category holds.
  const noun = singular(leaf.name);
  return `${stem} ${noun}`;
}

function singular(name: string): string {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y');
  if (/sses$/i.test(name)) return name.replace(/es$/i, '');
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.replace(/s$/i, '');
  return name;
}

function skuStem(storeName: string): string {
  const letters = storeName.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (letters.slice(0, 2) || 'TS').padEnd(2, 'X');
}

function uniqueSku(prefix: string, name: string, used: Set<string>): string {
  const base = `${prefix}-${slugify(name).replace(/-/g, '').toUpperCase().slice(0, 12)}`;
  let sku = base.slice(0, 34);
  let n = 2;
  while (used.has(sku)) sku = `${base.slice(0, 32)}-${n++}`;
  used.add(sku);
  return sku;
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}-${n++}`;
  used.add(key);
  return key;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function pickPrice(random: Random, range: { min: number; max: number }): number {
  const raw = range.min + random() * (range.max - range.min);
  const step = raw >= 1000 ? 50 : raw >= 200 ? 10 : raw >= 50 ? 5 : 1;
  return Math.max(step, Math.round(raw / step) * step);
}

function money(value: number): string {
  return value.toFixed(2);
}

function weigh(random: Random, [lo, hi]: [number, number]): string {
  const value = lo + random() * (hi - lo);
  // Two decimals below a kilo (jewellery), one above it — a 0.1 kg ring and a
  // 23.40 kg table are both wrong in the other direction.
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

function pickSome<T>(random: Random, list: readonly T[], min: number, max: number): T[] {
  const count = Math.max(
    1,
    Math.min(list.length, min + Math.floor(random() * (max - min + 1)))
  );
  return [...list]
    .map((item) => [random(), item] as const)
    .sort((a, b) => a[0] - b[0])
    .slice(0, count)
    .map(([, item]) => item);
}
