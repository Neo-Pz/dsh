/**
 * Build `lib/index.js`, the file DSH actually loads.
 *
 * Two things make this more than a one-line esbuild call:
 *
 * 1. The four `@deepseek-ai/*` packages stay EXTERNAL. DSH resolves them from
 *    the installation's single instance; bundling a second copy of cordis
 *    would give the plugin its own service registry and it would see nothing.
 *
 * 2. The three iFlow core packages are BUNDLED from the sibling `iflowone`
 *    repository. They are build-time only: consumers install this plugin from
 *    git and get the prebuilt `lib/index.js`, so they never need the sibling
 *    checkout or an extra dependency. Declaring them in package.json would
 *    break exactly that install path, which is why they are resolved by an
 *    alias plugin here instead.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corePackagesRoot = resolve(root, '..', 'iflowone', 'packages')

const IFLOW_CORE = {
  'iflow-adapter-sdk': join(corePackagesRoot, 'iflow-adapter-sdk', 'src', 'index.ts'),
  'iflow-domain': join(corePackagesRoot, 'iflow-domain', 'src', 'index.ts'),
  'iflow-protocol': join(corePackagesRoot, 'iflow-protocol', 'src', 'index.ts'),
}

const missing = Object.entries(IFLOW_CORE).filter(([, entry]) => !existsSync(entry))
if (missing.length > 0) {
  console.error(
    'Cannot build: the iFlow core packages were not found.\n' +
      missing.map(([name, entry]) => `  ${name} -> ${entry}`).join('\n') +
      '\n\nThe plugin bundles them from the sibling iflowone repository.\n' +
      'Clone it next to this one so that ../iflowone/packages/* exists.',
  )
  process.exit(1)
}

/** Map the bare iFlow package names to their TypeScript sources. */
const iflowCorePlugin = {
  name: 'iflow-core-alias',
  setup(pluginBuild) {
    const pattern = new RegExp(`^(${Object.keys(IFLOW_CORE).join('|')})$`)
    pluginBuild.onResolve({ filter: pattern }, (args) => ({ path: IFLOW_CORE[args.path] }))
  },
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
  plugins: [iflowCorePlugin],
  logLevel: 'info',
})
