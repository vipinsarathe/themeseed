/**
 * `themeseed magento-demo` — called by the magento-theme plugin as a
 * subprocess, so its contract is exit codes and one JSON object, not
 * interactivity (spec §6).
 *
 *   0  written      1  refused or failed (message names the fix)      2  usage
 *
 * Human output goes to stderr and the machine report to stdout, so `--json`
 * stays parseable even when warnings are printed.
 */

import pc from 'picocolors';

import { describeError, ThemeseedError } from '../../core/errors.js';
import {
  exportMagentoDemo,
  MagentoDemoUsageError,
} from '../../providers/magento/index.js';

export interface MagentoDemoFlags {
  request?: string;
  out?: string;
  credits?: string;
  json?: boolean;
}

export async function magentoDemoCommand(flags: MagentoDemoFlags = {}): Promise<void> {
  try {
    const missing = (['request', 'out', 'credits'] as const).filter(
      (name) => !flags[name]
    );
    if (missing.length > 0) {
      throw new MagentoDemoUsageError(
        `Missing required option${missing.length > 1 ? 's' : ''}: ${missing.map((m) => `--${m}`).join(', ')}`,
        'Usage: themeseed magento-demo --request <file> --out <theme>/demo --credits <file> [--json]'
      );
    }

    const report = await exportMagentoDemo({
      request: flags.request!,
      outDir: flags.out!,
      creditsPath: flags.credits!,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }

    for (const warning of report.warnings) console.error(`${pc.yellow('!')} ${warning}`);
    const counts = Object.entries(report.counts)
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${type} ${n}`)
      .join(', ');
    const files = report.written.filter((w) => w.startsWith('content-media/')).length;
    console.error(
      `${pc.green('✔')} Wrote catalog.json and ${files} image${files === 1 ? '' : 's'} to ${flags.out} (${counts})\n` +
        `  credits: ${report.credits}`
    );
  } catch (err) {
    const usage = err instanceof MagentoDemoUsageError;
    process.exitCode = usage ? 2 : 1;
    if (flags.json) {
      // A failure is still one JSON object, so a caller never has to parse prose.
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          code: err instanceof ThemeseedError ? err.code : 'ERROR',
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof ThemeseedError && err.hint ? { hint: err.hint } : {}),
        })}\n`
      );
    }
    console.error(`${pc.red('✖')} ${describeError(err)}`);
  }
}
