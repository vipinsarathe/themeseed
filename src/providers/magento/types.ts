/**
 * Shapes of the magento-content contract
 * (docs/superpowers/specs/2026-10-21-magento-demo-content-contract.md).
 *
 * Hand-written rather than generated from the schemas, for the same reason
 * `nic-demo/types.ts` is: the schemas are the authority and are enforced at
 * runtime by `schema.ts`; these types exist so the generator is checked by the
 * compiler.
 *
 * Everything here is Magento's vocabulary — attribute sets, configurable axes,
 * `{{store url}}` directives. That is the point of a provider directory: the
 * neutral model in `src/core/types.ts` knows none of it.
 */

// ---------------------------------------------------------------------------
// Request — what magento-theme writes
// ---------------------------------------------------------------------------

export type MagentoImageSource = 'auto' | 'local' | 'stock' | 'ai' | 'none';

export interface MagentoStore {
  name: string;
  /** What the business sells. Drives every generated noun. */
  topic: string;
  /** What ONE catalog entry IS — "Product", "Property", "Dish". */
  entry_noun?: string;
  entry_noun_plural?: string;
  language?: string;
  currency?: string;
  price_range?: { min: number; max: number };
}

export interface MagentoDepartmentChild {
  key: string;
  name: string;
  description?: string;
}

export interface MagentoDepartment extends MagentoDepartmentChild {
  children?: MagentoDepartmentChild[];
}

export interface MagentoAxisRequest {
  code: string;
  label: string;
  input?: 'select';
  swatch?: 'visual' | 'text';
}

export interface MagentoSeed {
  key: string;
  name: string;
  /** Must name a department or child key. */
  category?: string;
  price?: string;
  type?: MagentoProductType;
  sku?: string;
  description?: string;
  short_description?: string;
}

export interface MagentoCmsRequest {
  key: string;
  title: string;
  page_layout?: MagentoPageLayout;
}

export interface MagentoContentRequest {
  format: 'magento-content-request/1';
  theme: string;
  store: MagentoStore;
  images?: { source?: MagentoImageSource };
  catalog: {
    departments: MagentoDepartment[];
    products_per_leaf?: number;
    configurable_ratio?: number;
    axes?: MagentoAxisRequest[];
    seeds?: MagentoSeed[];
  };
  pages?: MagentoCmsRequest[];
  blocks?: MagentoCmsRequest[];
}

// ---------------------------------------------------------------------------
// Output — what ThemeSeed writes
// ---------------------------------------------------------------------------

export type MagentoAttributeInput = 'select' | 'multiselect' | 'text' | 'boolean';
export type MagentoProductType = 'simple' | 'configurable';
export type MagentoDisplayMode = 'PRODUCTS' | 'PRODUCTS_AND_PAGE';
export type MagentoPageLayout = '1column' | '2columns-right';

export interface MagentoAttributeOption {
  key: string;
  label: string;
  /** Hex colour, for a visual swatch option. */
  swatch?: string;
}

export interface MagentoAttribute {
  code: string;
  label: string;
  input: MagentoAttributeInput;
  /**
   * Required true for any attribute used as a configurable axis. Magento
   * refuses a non-global axis outright (`catalog_eav_attribute.is_global`),
   * which is a confusing failure to hit at `setup:upgrade` time.
   */
  global?: boolean;
  swatch?: 'visual' | 'text';
  options?: MagentoAttributeOption[];
}

export interface MagentoAttributeSet {
  key: string;
  name: string;
  attributes?: string[];
}

export interface MagentoCategory {
  key: string;
  name: string;
  url_key?: string;
  description?: string;
  display_mode?: MagentoDisplayMode;
  image?: string;
  /** Arbitrary depth. The importer derives path, level and url_path. */
  children?: MagentoCategory[];
}

export interface MagentoVariant {
  sku: string;
  price: string;
  weight?: string;
  image?: string;
  /** One value per axis: attribute code → option key. */
  values: Record<string, string>;
}

export interface MagentoProduct {
  key: string;
  sku: string;
  type: MagentoProductType;
  attribute_set?: string;
  name: string;
  url_key?: string;
  price: string;
  /** Strictly less than `price`. */
  special_price?: string;
  weight?: string;
  description?: string;
  short_description?: string;
  categories?: string[];
  image?: string;
  gallery?: string[];
  /** Non-axis values: attribute code → option key, or keys for a multiselect. */
  attributes?: Record<string, string | string[]>;
  /** Required for configurable, absent for simple. */
  axes?: string[];
  variants?: MagentoVariant[];
}

export interface MagentoCmsPage {
  key: string;
  title: string;
  content_heading?: string;
  page_layout?: MagentoPageLayout;
  content: string;
  meta_title?: string;
  meta_description?: string;
}

export interface MagentoCmsBlock {
  key: string;
  title: string;
  content: string;
}

export interface MagentoContent {
  format: 'magento-content/1';
  generator: string;
  theme: string;
  attributes?: MagentoAttribute[];
  attribute_sets?: MagentoAttributeSet[];
  categories: MagentoCategory[];
  products: MagentoProduct[];
  pages?: MagentoCmsPage[];
  blocks?: MagentoCmsBlock[];
}

// ---------------------------------------------------------------------------
// Limits and defaults — spec §4, §5.8
// ---------------------------------------------------------------------------

/**
 * Media rules, identical to the nic-demo contract because they are about files
 * rather than about a CMS.
 */
export const MAGENTO_MEDIA_LIMITS = {
  maxLongEdge: 2000,
  maxFileBytes: 500 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  namePattern: /^[a-z0-9][a-z0-9-]*\.(jpg|png|webp)$/,
} as const;

/** A storefront demo is not a catalog import — spec §4 rule 3. */
export const MAX_PRODUCTS = 200;

export const DEFAULT_PRODUCTS_PER_LEAF = 6;
export const DEFAULT_CONFIGURABLE_RATIO = 0.35;
/** Same floor and ceiling `quick-content.ts` falls back to today. */
export const DEFAULT_PRICE_RANGE = { min: 10, max: 120 } as const;
