import * as vscode from 'vscode';
import { join } from 'node:path';
import { brandIconPaths, type BrandIconPaths } from '../ui/brandIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** The shipped karst mark. The assets root is `dist/`, so media sits one level up. */
const BRAND_SVG = join(RUNTIME_ASSETS_ROOT, '..', 'media', 'karst.svg');

/** The shipped karst mark. The assets root is `dist/`, so media sits one level up. */
export function brandTabIcon(context: vscode.ExtensionContext): BrandIconPaths | undefined {
  try {
    return brandIconPaths({
      storageDir: context.globalStorageUri.fsPath,
      assetSvgPath: BRAND_SVG,
    });
  } catch {
    return undefined;
  }
}

/** Minimal starter body for a brand-new agent file created from Settings. */
export function agentStarterTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe what this subagent does.\n`;
}
