/**
 * Build `lib/index.js`, the file DSH actually loads.
 *
 * Two rules govern what gets bundled and what does not:
 *
 * 1. The `@deepseek-ai/*` packages stay EXTERNAL. DSH resolves them from the
 *    installation's single instance; bundling a second copy of cordis would
 *    give the plugin its own service registry, and it would then see none of
 *    the services it injects.
 *
 * 2. The iFlow core packages are BUNDLED. They are ordinary devDependencies
 *    resolved from node_modules, so a fresh clone builds with nothing but
 *    `npm install`. They are dev-only because the build inlines them: a
 *    consumer installing this plugin from git gets the prebuilt `lib/index.js`
 *    and never resolves them at runtime.
 *
 * To work against un-released changes in the core packages, `npm link` them —
 * that is what the tool is for, and it beats a bespoke path override here.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const IFLOW_CORE = ['iflow-adapter-sdk', 'iflow-domain', 'iflow-protocol']

// Presence check rather than `require.resolve`: these packages are ESM-only,
// with no `require` condition in their exports map, so resolving them from CJS
// throws even when they are installed correctly.
const missing = IFLOW_CORE.filter((name) => !existsSync(join(root, 'node_modules', name, 'package.json')))
if (missing.length > 0) {
  console.error(
    `Cannot build: ${missing.join(', ')} not installed.\n\n` +
      'Run `npm install` first. These are devDependencies bundled into\n' +
      'lib/index.js at build time; they are published on npm.',
  )
  process.exit(1)
}

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'lib', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: [
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/cordis',
  ],
  logLevel: 'info',
})
