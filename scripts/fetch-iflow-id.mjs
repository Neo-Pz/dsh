// Fetches the CI-built `iflow-id` binary for the current OS from the GitHub
// Release during install (the package "prepare" hook), so a fresh
// `dsh plugin add github:Neo-Pz/dsh` has the binary immediately — no runtime
// fetch, and no local Rust build.
//
// Best-effort by design: on failure it warns and exits 0 so the install still
// succeeds, because the plugin's runtime auto-fetch retries anyway. That
// fallback matters more than it sounds — pnpm keys build-script approval by the
// exact resolved commit, so every upgrade from a git ref needs re-approval and
// this hook is frequently never run at all.
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const asset = process.platform === 'win32'
  ? 'iflow-id-windows-amd64.exe'
  : process.platform === 'darwin'
    ? 'iflow-id-darwin-amd64'
    : 'iflow-id-linux-amd64'
const binName = process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id'
const destDir = join(root, 'rust', 'target', 'release')
const dest = join(destDir, binName)
const url = `https://github.com/Neo-Pz/dsh/releases/latest/download/${asset}`

// Smaller than any real build. A GitHub error page is a few KB, and that is
// exactly what this rejects.
const MIN_BYTES = 200 * 1024

function proxyArgs() {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy
  return proxy ? ['--proxy', proxy] : []
}

try {
  // Nothing to do when a real binary is already here — a local Rust build must
  // not be overwritten by a Release asset that may be older.
  try {
    if (statSync(dest).size >= MIN_BYTES) {
      console.log(`[iflow] ${dest} already present, skipping fetch`)
      process.exit(0)
    }
  } catch { /* not there: fetch it */ }

  console.log(`[iflow] fetching ${asset} ...`)
  mkdirSync(destDir, { recursive: true })

  // curl, so proxies and system TLS are honored the same way the plugin's own
  // outbound requests are. `-f` is what makes a 404 an error: without it
  // GitHub's error page is written to `dest` and curl exits 0, leaving a
  // "binary" that is HTML.
  execFileSync(
    'curl',
    ['-fsSL', '--retry', '3', '--retry-delay', '2', '-m', '180', '-o', dest, ...proxyArgs(), url],
    { stdio: 'inherit' },
  )

  const size = statSync(dest).size
  if (size < MIN_BYTES) {
    throw new Error(`downloaded ${size} bytes, too small to be the identity binary`)
  }
  // Release assets arrive without the executable bit.
  if (process.platform !== 'win32') chmodSync(dest, 0o755)

  console.log(`[iflow] wrote ${dest} (${size} bytes)`)
} catch (err) {
  // Best-effort: do not fail the install. The runtime retries, and now says why.
  console.warn(`[iflow] could not pre-fetch ${asset}: ${String(err && err.message ? err.message : err)}`)
  console.warn('[iflow] the plugin will fetch it on first use; run the iflow_fetch_identity tool to retry and see the reason.')
}
