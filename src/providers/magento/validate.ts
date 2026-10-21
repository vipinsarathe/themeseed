/**
 * Everything the JSON schema cannot say about a magento-content/1 package:
 * cross references, uniqueness, the configurable-axis rules, media limits and
 * credit coverage.
 *
 * Spec §9. The exporter runs this on its own output before writing a byte —
 * refusing is always better than shipping a package whose `setup:upgrade`
 * aborts halfway, because a data patch that throws leaves the module marked
 * un-applied and the merchant with a half-created catalog.
 */

import { probeImage } from '../../images/inspect.js';
import type { MediaFile } from '../../nic-demo/types.js';
import { validateMagentoContentSchema } from './schema.js';
import {
  MAGENTO_MEDIA_LIMITS,
  MAX_PRODUCTS,
  type MagentoAttribute,
  type MagentoCategory,
  type MagentoContent,
  type MagentoProduct,
} from './types.js';

export interface MagentoCredits {
  assets: Array<{ path: string; license: string; source: string; author: string }>;
}

export interface ValidateMagentoOptions {
  /** Files that will sit in `content-media/`. Omit to skip media checks. */
  media?: MediaFile[];
  /** Credits that will be written. Omit to skip coverage checks. */
  credits?: MagentoCredits;
}

const MEDIA_PREFIX = 'content-media/';

/** Returns problems; an empty array means the package is valid. */
export function validateMagentoContent(
  content: unknown,
  options: ValidateMagentoOptions = {}
): string[] {
  const schemaProblems = validateMagentoContentSchema(content);
  if (schemaProblems.length > 0) return schemaProblems;

  const doc = content as MagentoContent;
  const problems: string[] = [];

  const attributes = indexAttributes(doc, problems);
  const setKeys = checkAttributeSets(doc, attributes, problems);
  const categoryKeys = checkCategories(doc, problems);
  const referenced = checkProducts(doc, attributes, setKeys, categoryKeys, problems);
  checkCms(doc, referenced, problems);
  checkMedia(doc, referenced, options, problems);

  return problems;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

interface AttributeIndex {
  byCode: Map<string, MagentoAttribute>;
  optionKeys: Map<string, Set<string>>;
}

function indexAttributes(doc: MagentoContent, problems: string[]): AttributeIndex {
  const byCode = new Map<string, MagentoAttribute>();
  const optionKeys = new Map<string, Set<string>>();

  for (const attribute of doc.attributes ?? []) {
    if (byCode.has(attribute.code)) {
      problems.push(`attributes: code "${attribute.code}" appears twice`);
      continue;
    }
    byCode.set(attribute.code, attribute);

    const keys = new Set<string>();
    for (const option of attribute.options ?? []) {
      if (keys.has(option.key)) {
        problems.push(
          `attributes."${attribute.code}": option key "${option.key}" appears twice`
        );
      }
      keys.add(option.key);
      if (attribute.swatch === 'visual' && !option.swatch) {
        problems.push(
          `attributes."${attribute.code}": option "${option.key}" has no swatch colour, but the attribute is a visual swatch`
        );
      }
    }
    optionKeys.set(attribute.code, keys);

    const needsOptions =
      attribute.input === 'select' || attribute.input === 'multiselect';
    if (needsOptions && keys.size === 0) {
      problems.push(
        `attributes."${attribute.code}": a ${attribute.input} attribute with no options cannot be set on a product`
      );
    }
  }

  return { byCode, optionKeys };
}

function checkAttributeSets(
  doc: MagentoContent,
  attributes: AttributeIndex,
  problems: string[]
): Set<string> {
  const keys = new Set<string>();
  for (const set of doc.attribute_sets ?? []) {
    if (keys.has(set.key))
      problems.push(`attribute_sets: key "${set.key}" appears twice`);
    keys.add(set.key);
    for (const code of set.attributes ?? []) {
      if (!attributes.byCode.has(code)) {
        problems.push(`attribute_sets."${set.key}": unknown attribute "${code}"`);
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function checkCategories(doc: MagentoContent, problems: string[]): Set<string> {
  const keys = new Set<string>();

  const walk = (categories: MagentoCategory[], depth: number, path: string): void => {
    // Luma's deepest branch is Men > Tops > Jackets — level 4 counting the
    // root. Deeper than that and a breadcrumb stops fitting a header.
    if (depth > 4) {
      problems.push(`categories: "${path}" nests deeper than 4 levels`);
      return;
    }
    for (const category of categories) {
      if (keys.has(category.key)) {
        problems.push(`categories: key "${category.key}" appears twice`);
      }
      keys.add(category.key);
      if (category.children?.length) {
        walk(category.children, depth + 1, `${path}/${category.key}`);
      }
    }
  };

  walk(doc.categories, 1, '');
  return keys;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Every `content-media/` path the package refers to. */
function checkProducts(
  doc: MagentoContent,
  attributes: AttributeIndex,
  setKeys: Set<string>,
  categoryKeys: Set<string>,
  problems: string[]
): Set<string> {
  const referenced = new Set<string>();
  const productKeys = new Set<string>();
  const skus = new Set<string>();

  if (doc.products.length > MAX_PRODUCTS) {
    problems.push(
      `products: ${doc.products.length} exceeds the ${MAX_PRODUCTS} ceiling; a storefront demo is not a catalog import`
    );
  }

  for (const category of doc.categories) collectImage(category.image, referenced);
  for (const category of flatten(doc.categories))
    collectImage(category.image, referenced);

  for (const product of doc.products) {
    const where = `products."${product.key}"`;

    if (productKeys.has(product.key))
      problems.push(`products: key "${product.key}" appears twice`);
    productKeys.add(product.key);

    checkSku(product.sku, skus, where, problems);

    if (product.attribute_set && !setKeys.has(product.attribute_set)) {
      problems.push(`${where}: unknown attribute_set "${product.attribute_set}"`);
    }

    for (const key of product.categories ?? []) {
      if (!categoryKeys.has(key)) problems.push(`${where}: unknown category "${key}"`);
    }

    checkSpecialPrice(product, where, problems);
    checkProductAttributes(product, attributes, where, problems);
    checkVariants(product, attributes, skus, where, problems);

    collectImage(product.image, referenced);
    for (const path of product.gallery ?? []) collectImage(path, referenced);
    for (const variant of product.variants ?? []) collectImage(variant.image, referenced);
  }

  return referenced;
}

function checkSku(
  sku: string,
  seen: Set<string>,
  where: string,
  problems: string[]
): void {
  if (seen.has(sku)) {
    problems.push(
      `${where}: SKU "${sku}" is already used; SKUs are unique across products and variants`
    );
  }
  seen.add(sku);
}

function checkSpecialPrice(
  product: MagentoProduct,
  where: string,
  problems: string[]
): void {
  if (!product.special_price) return;
  if (Number(product.special_price) >= Number(product.price)) {
    problems.push(
      `${where}: special_price ${product.special_price} is not less than price ${product.price}`
    );
  }
}

function checkProductAttributes(
  product: MagentoProduct,
  attributes: AttributeIndex,
  where: string,
  problems: string[]
): void {
  for (const [code, value] of Object.entries(product.attributes ?? {})) {
    const attribute = attributes.byCode.get(code);
    if (!attribute) {
      problems.push(`${where}: unknown attribute "${code}"`);
      continue;
    }
    if (product.axes?.includes(code)) {
      problems.push(
        `${where}: "${code}" is an axis, so its value belongs on each variant rather than on the parent`
      );
    }
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && attribute.input !== 'multiselect') {
      problems.push(
        `${where}: "${code}" is a ${attribute.input}, so it takes one value, not a list`
      );
    }
    const known = attributes.optionKeys.get(code) ?? new Set<string>();
    if (attribute.input === 'select' || attribute.input === 'multiselect') {
      for (const option of values) {
        if (!known.has(option)) {
          problems.push(`${where}: "${code}" has no option "${option}"`);
        }
      }
    }
  }
}

function checkVariants(
  product: MagentoProduct,
  attributes: AttributeIndex,
  skus: Set<string>,
  where: string,
  problems: string[]
): void {
  if (product.type !== 'configurable') return;

  const axes = product.axes ?? [];
  for (const code of axes) {
    const attribute = attributes.byCode.get(code);
    if (!attribute) {
      problems.push(`${where}: unknown axis attribute "${code}"`);
      continue;
    }
    // Both are refused by Magento itself, and the failure surfaces as an
    // exception inside setup:upgrade rather than as anything readable.
    if (attribute.global !== true) {
      problems.push(
        `${where}: axis "${code}" must be global:true — Magento refuses a non-global configurable axis`
      );
    }
    if (attribute.input !== 'select') {
      problems.push(
        `${where}: axis "${code}" must be a select, not a ${attribute.input}`
      );
    }
  }

  const combinations = new Set<string>();
  for (const variant of product.variants ?? []) {
    checkSku(variant.sku, skus, `${where}.variants."${variant.sku}"`, problems);

    const parts: string[] = [];
    for (const code of axes) {
      const value = variant.values[code];
      if (value === undefined) {
        problems.push(`${where}.variants."${variant.sku}": no value for axis "${code}"`);
        parts.push('\u0000');
        continue;
      }
      const known = attributes.optionKeys.get(code) ?? new Set<string>();
      if (!known.has(value)) {
        problems.push(
          `${where}.variants."${variant.sku}": "${code}" has no option "${value}"`
        );
      }
      parts.push(value);
    }

    for (const code of Object.keys(variant.values)) {
      if (!axes.includes(code)) {
        problems.push(
          `${where}.variants."${variant.sku}": "${code}" is not one of this product's axes`
        );
      }
    }

    const signature = parts.join('|');
    if (combinations.has(signature)) {
      problems.push(
        `${where}: two variants share the combination ${signature.replace(/\|/g, ' + ')}`
      );
    }
    combinations.add(signature);
  }
}

// ---------------------------------------------------------------------------
// CMS
// ---------------------------------------------------------------------------

const SCRIPT = /<script\b/i;
/** An absolute link to the store's own pages; `{{store url}}` is the fix. */
const ABSOLUTE_LINK = /\b(?:href|src)\s*=\s*["']https?:\/\//i;
const REMOTE_IMG = /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;

function checkCms(
  doc: MagentoContent,
  referenced: Set<string>,
  problems: string[]
): void {
  const identifiers = new Set<string>();

  const check = (
    kind: 'pages' | 'blocks',
    entries: Array<{ key: string; content: string }>
  ): void => {
    for (const entry of entries) {
      const where = `${kind}."${entry.key}"`;
      if (identifiers.has(`${kind}:${entry.key}`)) {
        problems.push(`${kind}: identifier "${entry.key}" appears twice`);
      }
      identifiers.add(`${kind}:${entry.key}`);

      if (SCRIPT.test(entry.content))
        problems.push(`${where}: content contains <script>`);
      if (REMOTE_IMG.test(entry.content)) {
        problems.push(
          `${where}: content has a remote <img>; body images must reference content-media/ paths`
        );
      } else if (ABSOLUTE_LINK.test(entry.content)) {
        problems.push(
          `${where}: content has an absolute URL; use {{store url="…"}} so it resolves against the store's own base URL`
        );
      }

      for (const path of entry.content.matchAll(
        /content-media\/[a-z0-9][a-z0-9-]*\.(?:jpg|png|webp)/g
      )) {
        referenced.add(path[0]);
      }
    }
  };

  check('pages', doc.pages ?? []);
  check('blocks', doc.blocks ?? []);
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function checkMedia(
  doc: MagentoContent,
  referenced: Set<string>,
  options: ValidateMagentoOptions,
  problems: string[]
): void {
  const { media, credits } = options;
  if (!media) return;

  const names = new Set(media.map((file) => file.name));

  for (const path of referenced) {
    const name = path.slice(MEDIA_PREFIX.length);
    if (!names.has(name))
      problems.push(`${path} is referenced but not in content-media/`);
  }

  let total = 0;
  for (const file of media) {
    total += file.bytes.byteLength;
    if (!MAGENTO_MEDIA_LIMITS.namePattern.test(file.name)) {
      problems.push(
        `content-media/${file.name}: name must match ${MAGENTO_MEDIA_LIMITS.namePattern}`
      );
    }
    if (!referenced.has(`${MEDIA_PREFIX}${file.name}`)) {
      problems.push(`content-media/${file.name} is not referenced by anything`);
    }
    if (file.bytes.byteLength > MAGENTO_MEDIA_LIMITS.maxFileBytes) {
      problems.push(
        `content-media/${file.name}: ${Math.round(file.bytes.byteLength / 1024)} KB exceeds the ${MAGENTO_MEDIA_LIMITS.maxFileBytes / 1024} KB limit`
      );
    }
    const probed = probeImage(file.bytes);
    if (probed?.width && probed.height) {
      const longEdge = Math.max(probed.width, probed.height);
      if (longEdge > MAGENTO_MEDIA_LIMITS.maxLongEdge) {
        problems.push(
          `content-media/${file.name}: ${longEdge}px on the long edge exceeds ${MAGENTO_MEDIA_LIMITS.maxLongEdge}px`
        );
      }
    }
  }

  if (total > MAGENTO_MEDIA_LIMITS.maxTotalBytes) {
    problems.push(
      `content-media/ is ${Math.round(total / 1024 / 1024)} MB, over the ${MAGENTO_MEDIA_LIMITS.maxTotalBytes / 1024 / 1024} MB limit`
    );
  }

  if (credits) {
    // A credit entry's path is package-relative the way the THEME sees it —
    // `demo/content-media/x.jpg` — because the credits file is read beside the
    // theme, not beside this package. Matching on the file name is what makes
    // the two conventions agree without either having to know the other's.
    const credited = new Set(
      credits.assets.map((asset) => asset.path.slice(asset.path.lastIndexOf('/') + 1))
    );
    for (const file of media) {
      if (!credited.has(file.name)) {
        problems.push(`content-media/${file.name} has no credit entry`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function collectImage(path: string | undefined, into: Set<string>): void {
  if (path) into.add(path);
}
