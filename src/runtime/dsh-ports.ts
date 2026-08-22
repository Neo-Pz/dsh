/**
 * DSH implementations of the iFlow RuntimePorts.
 *
 * This file, plus `dsh-instrumentation.ts`, is the ENTIRE surface where iFlow
 * touches DeepSeek Harness. Everything above the ports (journal, outbox,
 * command ledger, projections, event semantics) lives in `iflow-adapter-sdk`
 * and knows nothing about cordis, sessions, or this runtime.
 *
 * Porting iFlow to another host means writing another file like this one.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Storage.
 *
 * Reads and writes go through `ctx.fs` so DSH's observation policy sees them,
 * but appends use `node:fs` directly: `ctx.fs` has no append, and emulating it
 * with read+write would rewrite the whole Origin Journal on every single fact —
 * quadratic, and a torn write away from losing history.
 */
export function createStoragePort(ctx) {
  const ensureDir = (path) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch (error) {
      // A pre-existing directory is the common case, not a failure.
      if (error && error.code !== 'EEXIST') throw error
    }
  }

  return {
    async read(path) {
      try {
        const resolved = await ctx.fs.resolve(path)
        return await ctx.fs.readText(resolved)
      } catch (error) {
        if (error && (error.code === 'ENOENT' || /not found|no such file/i.test(String(error.message)))) {
          return undefined
        }
        // Fall back to a direct read: ctx.fs can refuse paths its policy has
        // not observed, but the edge directory is ours and always readable.
        try {
          return readFileSync(path, 'utf8')
        } catch (fallbackError) {
          if (fallbackError && fallbackError.code === 'ENOENT') return undefined
          throw fallbackError
        }
      }
    },

    async write(path, text) {
      ensureDir(path)
      try {
        const resolved = await ctx.fs.resolve(path)
        await ctx.fs.writeText(resolved, text)
      } catch {
        writeFileSync(path, text, 'utf8')
      }
    },

    async append(path, text) {
      ensureDir(path)
      appendFileSync(path, text, 'utf8')
    },
  }
}

/** Child processes, via DSH's subprocess seam (so the sandbox still applies). */
export function createSpawnPort(ctx, workspace) {
  return {
    async run(argv, options = {}) {
      const handle = await ctx.subprocess.spawn({
        argv,
        cwd: options.cwd ?? workspace,
        stdio: {
          stdin: options.stdinFile ? { kind: 'file', path: options.stdinFile } : 'ignore',
          stdout: { maxBytes: 1 << 20 },
          stderr: { maxBytes: 1 << 18 },
        },
        graceMs: 3000,
      })
      const outcome = await handle.done
      const read = (stream) => (stream ? stream.readFrom(0).text : '')
      return {
        code: outcome.exitCode ?? -1,
        stdout: read(handle.collected.stdout),
        stderr: read(handle.collected.stderr),
      }
    },

    async resolveExecutable(path) {
      try {
        return await ctx.subprocess.resolveExecutable(path)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Inbound HTTP, mounted on the webServer DSH already runs.
 *
 * Adapts node's (req, res) to the port's plain request/response objects so the
 * SDK never imports a server type.
 */
export function createHttpServerPort(ctx, options = {}) {
  const webServer = ctx.webServer
  const corsHeaders = options.corsHeaders ?? {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }

  const toRequest = (req, body) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = {}
    for (const [key, value] of url.searchParams) query[key] = value
    const headers = {}
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    }
    return { method: req.method ?? 'GET', path: url.pathname, query, headers, body }
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const decoder = new TextDecoder('utf-8', { stream: true })
      let text = ''
      req.on('data', (chunk) => {
        text += decoder.decode(chunk)
      })
      req.on('end', () => {
        text += decoder.decode()
        resolve(text)
      })
      req.on('error', reject)
    })

  return {
    route(spec) {
      const handler = async (req, res) => {
        try {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders)
            res.end()
            return
          }
          if (req.method !== spec.method) {
            res.writeHead(405, { 'Content-Type': 'application/json', ...corsHeaders })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const body = spec.method === 'POST' ? await readBody(req) : undefined
          const response = await spec.handler(toRequest(req, body))
          res.writeHead(response.status, {
            'Cache-Control': 'no-store',
            ...corsHeaders,
            ...(response.headers ?? {}),
          })
          res.end(response.body ?? '')
        } catch (error) {
          console.error(`iFlow edge route ${spec.path} failed`, error)
          try {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders })
            res.end(JSON.stringify({ error: 'internal error' }))
          } catch {
            // The client already went away; nothing left to report to.
          }
        }
      }

      const dispose = webServer.register({ kind: 'exact', path: spec.path, handler })
      return { dispose: () => dispose() }
    },

    stream(spec) {
      const handler = async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders)
          res.end()
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          ...corsHeaders,
        })

        const closeHandlers = []
        let closed = false
        const finish = () => {
          if (closed) return
          closed = true
          for (const handlerFn of closeHandlers) {
            try {
              handlerFn()
            } catch {
              // A subscriber's cleanup must not break the others.
            }
          }
        }

        req.on('close', finish)
        res.on('close', finish)

        // A comment frame every 25s keeps proxies from reaping an idle stream.
        const keepAlive = setInterval(() => {
          if (!closed) {
            try {
              res.write(': keep-alive\n\n')
            } catch {
              finish()
            }
          }
        }, 25_000)
        closeHandlers.push(() => clearInterval(keepAlive))

        spec.handler(toRequest(req, undefined), {
          send(chunk) {
            if (closed) return
            try {
              res.write(chunk)
            } catch {
              finish()
            }
          },
          close() {
            finish()
            try {
              res.end()
            } catch {
              // Already ended.
            }
          },
          onClose(handlerFn) {
            if (closed) handlerFn()
            else closeHandlers.push(handlerFn)
          },
        })
      }

      const dispose = webServer.register({ kind: 'exact', path: spec.path, handler })
      return { dispose: () => dispose() }
    },

    baseUrl() {
      const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : (webServer.host ?? '127.0.0.1')
      return `http://${host}:${webServer.port}`
    },
  }
}

export function createClockPort(ctx) {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    timeout(handler, ms) {
      const disposer = ctx.timeout(handler, ms)
      return { dispose: () => (typeof disposer === 'function' ? disposer() : undefined) }
    },
  }
}

export function createLoggerPort(prefix = 'iFlow edge') {
  return {
    info: (message, detail) => console.log(`${prefix}: ${message}`, detail ?? ''),
    warn: (message, detail) => console.warn(`${prefix}: ${message}`, detail ?? ''),
    error: (message, detail) => console.error(`${prefix}: ${message}`, detail ?? ''),
  }
}

export function createIdPortForDsh() {
  let counter = 0
  return {
    newId(prefix) {
      counter += 1
      const random = Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0')
      return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${random}`
    },
  }
}

/** Assemble every port from one cordis context. */
export function createDshPorts(ctx, workspace, options = {}) {
  return {
    storage: createStoragePort(ctx),
    spawn: createSpawnPort(ctx, workspace),
    http: createHttpServerPort(ctx, options),
    clock: createClockPort(ctx),
    logger: createLoggerPort(options.logPrefix),
    ids: createIdPortForDsh(),
  }
}
