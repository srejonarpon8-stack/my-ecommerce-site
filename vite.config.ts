import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

const DEFAULT_BASE_URL = 'https://freebuff.com/api/v1/paid'
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

function createChatMiddleware(env: Record<string, string>): Middleware {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    const apiKey = (env.OPENAI_API_KEY || '').trim()
    if (!apiKey) {
      sendJson(res, 503, {
        error: 'chat_not_configured',
        message:
          'The assistant needs an API key. Create one at freebuff.com/account/api and put it in .env as OPENAI_API_KEY.',
      })
      return
    }

    let payload: { messages?: unknown; model?: unknown } | null = null
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }

    const incoming = Array.isArray(payload?.messages) ? payload?.messages : []
    const messages = incoming
      .filter(
        (m): m is { role: string; content: string } =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as { role?: unknown }).role === 'string' &&
          typeof (m as { content?: unknown }).content === 'string',
      )
      .slice(-24)
      .map((m) => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content).slice(0, 12000),
      }))

    if (!messages.length) {
      sendJson(res, 400, { error: 'no_messages' })
      return
    }

    const baseUrl = (env.CHAT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const model = (env.CHAT_MODEL || DEFAULT_MODEL).trim()
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    try {
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: 0.7,
          max_tokens: 1400,
        }),
      })

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '')
        sendJson(res, upstream.status || 502, {
          error: 'upstream_error',
          status: upstream.status,
          detail: detail.slice(0, 800) || 'No response body from the model provider.',
        })
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store, no-transform')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      res.flushHeaders?.()

      const stream = Readable.fromWeb(upstream.body as never)
      stream.on('error', () => res.end())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch (error) {
      if (controller.signal.aborted) return
      sendJson(res, 502, {
        error: 'chat_unreachable',
        message: error instanceof Error ? error.message : 'Could not reach the model provider.',
      })
    }
  }
}

function chatStatus(env: Record<string, string>, warn: (message: string) => void, info: (message: string) => void) {
  const key = (env.OPENAI_API_KEY || '').trim()
  if (key) {
    info(`Nexa Assist: API key detected (${key.length} chars) - chat is enabled.`)
  } else {
    warn(
      'Nexa Assist: OPENAI_API_KEY is empty, so the chat panel will show setup instructions.\n' +
        '              Add your key to .env and restart: npm run dev',
    )
  }
}

function chatPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'nexa-chat-api',
    configureServer(server) {
      chatStatus(env, (m) => server.config.logger.warn(m), (m) => server.config.logger.info(m))
      server.middlewares.use('/api/chat', createChatMiddleware(env))
    },
    configurePreviewServer(server) {
      chatStatus(env, (m) => server.config.logger.warn(m), (m) => server.config.logger.info(m))
      server.middlewares.use('/api/chat', createChatMiddleware(env))
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), chatPlugin(env)],
    server: { port: 5173 },
    preview: { port: 4173 },
  }
})
