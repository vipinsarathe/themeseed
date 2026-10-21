/**
 * Writes the package. By the time this runs everything is validated and in
 * memory, so a failure here can only be the filesystem.
 *
 * Isolation rule (spec §6.3): `catalog.json` and `content-media/` are replaced
 * wholesale and nothing else inside `outDir` is touched. Both are staged under
 * hidden names in `outDir` and renamed into place, so an interrupted run leaves
 * the previous package intact rather than half of each.
 *
 * Deliberately a near-copy of `nic-demo/write.ts` rather than a shared helper:
 * the two contracts name different files and may diverge, and the atomicity
 * dance is the part worth having twice.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MediaFile } from '../../nic-demo/types.js';
import type { MagentoContent } from './types.js';
import type { MagentoCredits } from './validate.js';

export interface WriteMagentoArgs {
  outDir: string;
  creditsPath: string;
  content: MagentoContent;
  media: MediaFile[];
  credits: MagentoCredits;
}

export async function writeMagentoPackage(args: WriteMagentoArgs): Promise<string[]> {
  const { outDir } = args;
  await fs.mkdir(outDir, { recursive: true });

  const stamp = `${process.pid}-${Date.now()}`;
  const stagedCatalog = path.join(outDir, `.catalog.json.${stamp}.tmp`);
  const stagedMedia = path.join(outDir, `.content-media.${stamp}.tmp`);

  try {
    await fs.writeFile(stagedCatalog, `${JSON.stringify(args.content, null, 2)}\n`);
    await fs.mkdir(stagedMedia, { recursive: true });
    for (const file of args.media) {
      await fs.writeFile(path.join(stagedMedia, file.name), file.bytes);
    }

    // The old folder goes first so files of a previous run cannot linger.
    await fs.rm(path.join(outDir, 'content-media'), { recursive: true, force: true });
    await fs.rename(stagedMedia, path.join(outDir, 'content-media'));
    await fs.rename(stagedCatalog, path.join(outDir, 'catalog.json'));
  } finally {
    await fs.rm(stagedCatalog, { force: true });
    await fs.rm(stagedMedia, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(args.creditsPath), { recursive: true });
  const stagedCredits = `${args.creditsPath}.${stamp}.tmp`;
  try {
    await fs.writeFile(stagedCredits, `${JSON.stringify(args.credits, null, 2)}\n`);
    await fs.rename(stagedCredits, args.creditsPath);
  } finally {
    await fs.rm(stagedCredits, { force: true });
  }

  return [
    'catalog.json',
    ...args.media.map((file) => `content-media/${file.name}`).sort(),
  ];
}
