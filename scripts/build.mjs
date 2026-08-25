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

import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Being installed is not the same as being the right one.
 *
 * These three are INLINED into lib/index.js, so whatever sits in node_modules
 * at this moment is what ships. And `npm install` — for anything, including an
 * unrelated devDependency — silently replaces an `npm link` with whatever the
 * registry has.
 *
 * That produced a bundle whose observer was missing methods the plugin calls,
 * failing at runtime with `observer.conversationOpened is not a function`,
 * nowhere near the cause. It was caught only because a test happened to
 * journal a conversation. Refuse here instead.
 */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const wrongVersion = []
for (const name of IFLOW_CORE) {
  const wanted = manifest.devDependencies?.[name]
  if (!wanted) continue
  const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
  if (!satisfiesCaret(installed, wanted)) wrongVersion.push({ name, wanted, installed })
}
if (wrongVersion.length > 0) {
  console.error(
    'Cannot build: the iFlow core packages in node_modules are not what package.json asks for.\n\n' +
      wrongVersion.map(({ name, wanted, installed }) => `  ${name}: want ${wanted}, have ${installed}`).join('\n') +
      '\n\nThese are inlined into lib/index.js, so building now would ship the wrong code.\n' +
      'If you are developing against the local workspace, an `npm install` has replaced\n' +
      'your links with registry copies. Relink them:\n\n' +
      '  npm link ../iflowone/packages/iflow-protocol \\\n' +
      '           ../iflowone/packages/iflow-domain \\\n' +
      '           ../iflowone/packages/iflow-adapter-sdk\n',
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

// The browser half is part of the same artifact: DSH loads `lib/index.js` and
// `lib/client.js` from one install, and shipping a stale one of the pair is
// the kind of mismatch that only shows up in someone else's browser.
await import('./build-client.mjs')

/**
 * Enough semver for one job: does `installed` satisfy a `^x.y.z` range?
 *
 * Deliberately not a dependency. The only ranges this repo uses are carets,
 * and below 1.0.0 a caret pins the minor too — `^0.2.0` does not accept 0.1.0,
 * which is exactly the case this check exists for.
 */
function satisfiesCaret(installed, range) {
  const wanted = range.replace(/^[\^~]/, '')
  const [wMajor, wMinor, wPatch] = wanted.split('.').map(Number)
  const [iMajor, iMinor, iPatch] = installed.split('.').map(Number)
  if (!range.startsWith('^')) return installed === wanted
  if (iMajor !== wMajor) return false
  if (wMajor === 0) return iMinor === wMinor && iPatch >= wPatch
  return iMinor > wMinor || (iMinor === wMinor && iPatch >= wPatch)
}
