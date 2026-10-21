/**
 * Which image source may run for a Magento demo.
 *
 * Simpler than the nic-demo rule, and deliberately so. That contract refuses
 * stock photography for `themeforest` and `wordpress.org` targets because
 * those marketplaces redistribute the theme under the GPL and the stock
 * licences are not compatible. Magento themes have no equivalent marketplace
 * rule today, so the requested source is honoured as given and the credits
 * file (spec §7) is what makes the licence position auditable instead.
 *
 * The `auto` ladder still runs AI first: an AI image matches the subject
 * exactly, which matters more on a product tile than on a blog hero.
 */

import { createImageSource, hasAiKey, hasStockKey } from '../../images/index.js';
import type { ImageSourceOptions } from '../../images/index.js';
import type { ImageSource } from '../../images/source.js';
import { ThemeseedError } from '../../core/errors.js';
import type { MagentoImageSource } from './types.js';

export interface MagentoSourceChoice {
  /** Null means "no images". */
  source: ImageSource | null;
  warnings: string[];
}

export async function chooseMagentoImageSource(
  requested: MagentoImageSource,
  options: {
    sourceOptions?: ImageSourceOptions;
    override?: ImageSource;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<MagentoSourceChoice> {
  const warnings: string[] = [];
  const env = options.env ?? process.env;

  if (requested === 'none') return { source: null, warnings };

  let source: ImageSource;
  if (options.override) {
    source = options.override;
  } else if (requested === 'auto') {
    source = await resolveAuto(options.sourceOptions ?? {}, env, warnings);
  } else {
    source = createImageSource(requested, options.sourceOptions ?? {});
  }

  if (source.kind === 'none') return { source: null, warnings };

  // An explicit kind fails loudly: it was the caller's decision, and silently
  // producing a pictureless storefront would hide it.
  if (!(await source.isAvailable())) {
    throw new ThemeseedError(`Image source "${source.kind}" is not usable`, {
      code: 'IMAGE_SOURCE_UNAVAILABLE',
      hint: await source.unavailableReason(),
    });
  }
  return { source, warnings };
}

async function resolveAuto(
  options: ImageSourceOptions,
  env: NodeJS.ProcessEnv,
  warnings: string[]
): Promise<ImageSource> {
  if (hasAiKey(env)) return createImageSource('ai', options);

  const localDir = options.local?.directory ?? env.THEMESEED_LOCAL_IMAGE_DIR;
  if (localDir) {
    const local = createImageSource('local', options);
    if (await local.isAvailable()) return local;
    warnings.push(
      `images.source "auto": local folder skipped — ${await local.unavailableReason()}`
    );
  }

  if (hasStockKey(env)) return createImageSource('stock', options);

  warnings.push(
    'images.source "auto" found no usable source, so the demo has no images and every product ' +
      "will show Magento's grey placeholder. Set an AI key (OPENAI_API_KEY, XAI_API_KEY, " +
      'GOOGLE_API_KEY, FAL_KEY), a stock key (UNSPLASH_ACCESS_KEY, PEXELS_API_KEY), or point ' +
      'THEMESEED_LOCAL_IMAGE_DIR at your own images.'
  );
  return createImageSource('none');
}
