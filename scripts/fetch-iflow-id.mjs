// Fetches the CI-built `iflow-id` binary for the current OS from the GitHub
// Release during install (package "prepare" hook), so a fresh
// `dsh plugin add github:Neo-Pz/dsh` has the binary immediately — no runtime
// fetch, and no local Rust build. Best-effort: on failure it logs a warning
// and exits 0 so the install still succeeds (the plugin's runtime auto-fetch
// then serves as the fallback).
import { mkdirSync } from 'node:fs'
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

try {
  console.log(`[iflow] fetching ${asset} ...`)
  mkdirSync(destDir, { recursive: true })
  // curl (like the plugin's runtime auto-fetch) so proxies/TLS get honored; the
  // plugin also uses curl for outbound requests, so this is the proven path.
  execFileSync('curl', ['-sSL', '--retry', '3', '-m', '120', '-o', dest, url], { stdio: 'inherit' })
  const size = (await import('node:fs')).statSync(dest).size
  console.log(`[iflow] wrote ${dest} (${size} bytes)`)
} catch (err) {
  // Best-effort: don't fail the install; runtime auto-fetch will retry.
  console.warn(`[iflow] could not pre-fetch ${asset}: ${String(err && err.message ? err.message : err)}`)
  console.warn('[iflow] the plugin will try to fetch it on first use.')
}
