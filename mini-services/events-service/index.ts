// ============================================================
// EVENTS SERVICE — WebSocket em tempo real (socket.io)
//
// Porta 3003: socket.io (path '/') — clientes via gateway
//   io("/?XTransformPort=3003")
// Porta 3004: HTTP ingest — o backend Next.js faz POST /ingest
//   → retransmite via broadcast aos clientes conectados.
// ============================================================

import { createServer } from 'http'
import { Server } from 'socket.io'

// Portas configuráveis via env (server-side; opcional no deploy —
// sem este serviço a UI degrada para polling /api/activity)
const SOCKET_PORT = Number(process.env.EVENTS_PORT ?? 3003)
const INGEST_PORT = Number(process.env.EVENTS_INGEST_PORT ?? 3004)

// ---------- Socket.io (clientes da UI) ----------
const socketServer = createServer()
const io = new Server(socketServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/',
})

io.on('connection', (socket) => {
  console.log(`[events] client conectado: ${socket.id}`)
  socket.emit('studio:hello', { service: 'ai-dev-studio-events', at: new Date().toISOString() })
  socket.on('disconnect', () => {
    console.log(`[events] client saiu: ${socket.id}`)
  })
})

socketServer.listen(SOCKET_PORT, () => {
  console.log(`[events] socket.io ativo em :${SOCKET_PORT} (path /)`)
})

// ---------- HTTP ingest (backend Next.js) ----------
const ingestServer = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/ingest') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy() // proteção de payload
    })
    req.on('end', () => {
      try {
        const event = JSON.parse(body)
        // Sanitização: nunca retransmite campos de secret
        for (const key of Object.keys(event)) {
          if (/token|password|secret|apikey/i.test(key)) delete event[key]
        }
        io.emit('studio:event', event)
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'payload inválido' }))
      }
    })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'events', socketPort: SOCKET_PORT, ingestPort: INGEST_PORT }))
    return
  }

  res.writeHead(404)
  res.end()
})

ingestServer.listen(INGEST_PORT, () => {
  console.log(`[events] ingest HTTP ativo em :${INGEST_PORT} (POST /ingest)`)
})
