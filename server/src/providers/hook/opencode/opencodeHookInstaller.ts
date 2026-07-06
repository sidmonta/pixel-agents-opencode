import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OPENCODE_PLUGIN_NAME, OPENCODE_PLUGINS_DIR } from './constants.js';

/** Returns the absolute path to ~/.config/opencode/plugins/. */
function getPluginDir(): string {
  return path.join(os.homedir(), OPENCODE_PLUGINS_DIR);
}

/** Returns the destination path for the plugin file. */
function getPluginPath(): string {
  return path.join(getPluginDir(), OPENCODE_PLUGIN_NAME);
}

/** Check if the Pixel Agents plugin file exists in the Opencode plugins directory. */
export function areHooksInstalled(): boolean {
  return fs.existsSync(getPluginPath());
}

/**
 * Install the Pixel Agents plugin into Opencode's plugin directory.
 * Copies the bundled plugin file to ~/.config/opencode/plugins/pixel-agents.mjs.
 */
export function installHooks(): void {
  const dst = getPluginPath();
  const dstDir = path.dirname(dst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  }
  // The plugin file must already be bundled by esbuild into dist/hooks/.
  // The installer is called after copyPluginScript places it.
  console.log(`[Pixel Agents] Opencode plugin path: ${dst}`);
  if (!fs.existsSync(dst)) {
    console.warn(`[Pixel Agents] Opencode plugin not found at ${dst} — ensure copyPluginScript was called first`);
  }
}

/**
 * Remove the Pixel Agents plugin from Opencode's plugin directory.
 */
export function uninstallHooks(): void {
  const dst = getPluginPath();
  try {
    if (fs.existsSync(dst)) {
      fs.unlinkSync(dst);
      console.log('[Pixel Agents] Opencode plugin uninstalled');
    }
    // Clean up empty plugin dir
    const dir = getPluginDir();
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to remove Opencode plugin: ${e}`);
  }
}

/** Copy the bundled plugin file from dist/hooks/ to ~/.config/opencode/plugins/. */
export function copyPluginScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', OPENCODE_PLUGIN_NAME);
  const dst = getPluginPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Opencode plugin script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Opencode plugin installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Opencode plugin script: ${e}`);
  }
}
