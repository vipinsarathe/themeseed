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
const SIZE_SCALES: ReadonlyArray<{
  match: RegExp;
  options: ReadonlyArray<{ key: string; label: string }>;
}> = [
  {
    match:
      /\b(furniture|sofa|seating|interior|home decor|homeware|decor|lighting|lamp)\b/i,
    options: [
      { key: 'two-seat', label: 'Two-seat' },
      { key: 'three-seat', label: 'Three-seat' },
      { key: 'compact', label: 'Compact' },
      { key: 'wide', label: 'Wide' },
    ],
  },
  {
    match: /\b(coffee|tea|food|grocer\w*|spice|snack|bakery|roaster\w*)\b/i,
    options: [
      { key: '250g', label: '250 g' },
      { key: '500g', label: '500 g' },
      { key: '1kg', label: '1 kg' },
    ],
  },
  {
    match: /\b(jewel\w*|ring|watch|accessor\w*)\b/i,
    options: [
      { key: '16cm', label: '16 cm' },
      { key: '18cm', label: '18 cm' },
      { key: '20cm', label: '20 cm' },
    ],
  },
];

/** Apparel letter sizes, and the fallback for a topic that names nothing else. */
const APPAREL_SIZES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'xs', label: 'XS' },
  { key: 's', label: 'S' },
  { key: 'm', label: 'M' },
  { key: 'l', label: 'L' },
  { key: 'xl', label: 'XL' },
];

function sizesFor(
  topic: string
): ReadonlyArray<{ key: string; label: string; swatch?: string }> {
  return SIZE_SCALES.find((scale) => scale.match.test(topic))?.options ?? APPAREL_SIZES;
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

/** Non-axis attributes every generated set carries, for layered nav to filter on. */
const MATERIALS = [
  'Oak',
  'Walnut',
  'Linen',
  'Cotton',
  'Leather',
  'Steel',
  'Glass',
  'Wool',
];

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
  const attributes: MagentoAttribute[] = [];

  if (ratio > 0) {
    const axes = request.catalog.axes ?? [
      { code: 'color', label: 'Colour', swatch: 'visual' as const },
      { code: 'size', label: 'Size', swatch: 'text' as const },
    ];

    const sizes = sizesFor(request.store.topic);
    for (const axis of axes) {
      const visual = axis.swatch === 'visual';
      const options: MagentoAttributeOption[] = (
        axis.code === 'size' ? sizes : COLOURS
      ).map((option) => ({
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
        ...(axis.swatch ? { swatch: axis.swatch } : {}),
        options,
      });
    }
  }

  // One multiselect so layered navigation has something to filter on beyond
  // the axes — Luma's own `material` plays exactly this role.
  attributes.push({
    code: 'material',
    label: 'Material',
    input: 'multiselect',
    global: false,
    options: MATERIALS.map((name) => ({ key: slugify(name), label: name })),
  });

  return attributes;
}

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
  const material = attributes.find((a) => a.code === 'material');
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
        material,
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
          material,
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
  material: MagentoAttribute | undefined;
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

  if (args.material?.options?.length) {
    const chosen = pickSome(args.random, args.material.options, 1, 2).map(
      (option) => option.key
    );
    product.attributes = { material: chosen };
  }

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
