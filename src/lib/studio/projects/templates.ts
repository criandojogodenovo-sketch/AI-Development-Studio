// ============================================================
// PROJECTS / TEMPLATES — Estruturas iniciais reais por tipo
// Cada template gera arquivos funcionais no workspace.
// Jogos: mobile-first, canvas responsivo, game loop,
// touch controls, asset management, áudio.
// ============================================================

export interface TemplateFile {
  path: string
  content: string
}

export interface ProjectTemplate {
  type: string
  label: string
  description: string
  testCommand: string
  files: TemplateFile[]
}

const README_BASE = (name: string, type: string, desc: string) =>
  `# ${name}

> Projeto criado pelo AI Development Studio — tipo: ${type}

${desc}

## Como rodar

\`\`\`bash
npm install
npm test
\`\`\`

## Estrutura

- \`src/\` — código-fonte principal
- \`test/\` — testes automatizados (node:test)
- \`index.html\` — ponto de entrada web (quando aplicável)

Gerado em ${new Date().toISOString()}
`

const GAME_HTML = (title: string) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #0a0a12; touch-action: none; }
  #game { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body>
</html>
`

const GAME_ENGINE = `// ============================================================
// Engine base — game loop com delta time + canvas responsivo
// mobile-first com touch controls
// ============================================================
export class Game {
  constructor(canvas, { width = 720, height = 1280 } = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.W = width; this.H = height
    this.running = false
    this.last = 0
    this.input = { x: 0, y: 0, active: false, keys: new Set() }
    this._resize()
    window.addEventListener('resize', () => this._resize())
    this._bindInput()
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const scale = Math.min(window.innerWidth / this.W, window.innerHeight / this.H)
    this.canvas.style.width = this.W * scale + 'px'
    this.canvas.style.height = this.H * scale + 'px'
    this.canvas.width = this.W * dpr
    this.canvas.height = this.H * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const rect = this.canvas.getBoundingClientRect()
    this._sx = this.W / rect.width
    this._sy = this.H / rect.height
  }

  _bindInput() {
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect()
      const t = e.touches ? e.touches[0] : e
      return { x: (t.clientX - r.left) * this._sx, y: (t.clientY - r.top) * this._sy }
    }
    const down = (e) => { const p = pos(e); this.input.active = true; this.input.x = p.x; this.input.y = p.y; this.onPointerDown && this.onPointerDown(p) }
    const move = (e) => { const p = pos(e); this.input.x = p.x; this.input.y = p.y; this.onPointerMove && this.onPointerMove(p) }
    const up = () => { this.input.active = false; this.onPointerUp && this.onPointerUp() }
    this.canvas.addEventListener('touchstart', down, { passive: true })
    this.canvas.addEventListener('touchmove', move, { passive: true })
    this.canvas.addEventListener('touchend', up, { passive: true })
    this.canvas.addEventListener('mousedown', down)
    this.canvas.addEventListener('mousemove', move)
    this.canvas.addEventListener('mouseup', up)
    window.addEventListener('keydown', (e) => this.input.keys.add(e.key))
    window.addEventListener('keyup', (e) => this.input.keys.delete(e.key))
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = (t) => {
      if (!this.running) return
      const dt = Math.min((t - this.last) / 1000, 1 / 30)
      this.last = t
      this.update(dt)
      this.render(this.ctx)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  stop() { this.running = false }

  update(dt) {}
  render(ctx) {}
}

// Audio manager simples (WebAudio, sem assets externos)
export class AudioManager {
  constructor() { this.ctx = null; this.muted = false }
  _ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)()
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }
  beep(freq = 440, duration = 0.1, type = 'square', volume = 0.15) {
    if (this.muted) return
    try {
      this._ensure()
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      osc.type = type
      osc.frequency.value = freq
      gain.gain.setValueAtTime(volume, this.ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration)
      osc.connect(gain).connect(this.ctx.destination)
      osc.start()
      osc.stop(this.ctx.currentTime + duration)
    } catch (e) { /* áudio bloqueado até interação */ }
  }
}
`

const GAME_MAIN = (name: string) => `import { Game, AudioManager } from './engine.js'

// ${name} — mini-game 2D mobile-first
class ${name.replace(/[^a-zA-Z0-9]/g, '') || 'MyGame'} extends Game {
  constructor(canvas) {
    super(canvas)
    this.audio = new AudioManager()
    this.score = 0
    this.gameOver = false
    this.player = { x: this.W / 2, y: this.H * 0.8, r: 24, speed: 320 }
    this.items = []
    this.spawnTimer = 0
    this.reset()
  }

  reset() {
    this.score = 0
    this.gameOver = false
    this.items = []
    this.player.x = this.W / 2
  }

  update(dt) {
    if (this.gameOver) {
      if (this.input.active) this.reset()
      return
    }
    // Controles: touch arrasta o player; teclado opcional
    if (this.input.active) {
      const target = this.input.x
      const dx = target - this.player.x
      this.player.x += Math.max(-this.player.speed * dt, Math.min(this.player.speed * dt, dx))
    }
    if (this.input.keys.has('ArrowLeft')) this.player.x -= this.player.speed * dt
    if (this.input.keys.has('ArrowRight')) this.player.x += this.player.speed * dt
    this.player.x = Math.max(this.player.r, Math.min(this.W - this.player.r, this.player.x))

    // Spawn de itens
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.8
      const good = Math.random() > 0.3
      this.items.push({
        x: 40 + Math.random() * (this.W - 80),
        y: -30,
        vy: 220 + Math.random() * 160,
        good,
      })
    }

    // Física + colisão
    for (const it of this.items) {
      it.y += it.vy * dt
      const dx = it.x - this.player.x
      const dy = it.y - this.player.y
      if (Math.hypot(dx, dy) < this.player.r + 16) {
        it.dead = true
        if (it.good) {
          this.score += 10
          this.audio.beep(660, 0.08, 'sine', 0.2)
        } else {
          this.gameOver = true
          this.audio.beep(120, 0.4, 'sawtooth', 0.2)
        }
      }
      if (it.y > this.H + 40) it.dead = true
    }
    this.items = this.items.filter((i) => !i.dead)
  }

  render(ctx) {
    // Fundo
    const grad = ctx.createLinearGradient(0, 0, 0, this.H)
    grad.addColorStop(0, '#0a0a12')
    grad.addColorStop(1, '#1a1a3e')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, this.W, this.H)

    // Player
    ctx.fillStyle = '#4ade80'
    ctx.beginPath()
    ctx.arc(this.player.x, this.player.y, this.player.r, 0, Math.PI * 2)
    ctx.fill()

    // Itens
    for (const it of this.items) {
      ctx.fillStyle = it.good ? '#facc15' : '#f87171'
      ctx.beginPath()
      ctx.arc(it.x, it.y, 16, 0, Math.PI * 2)
      ctx.fill()
    }

    // HUD
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 32px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('Pontos: ' + this.score, 24, 52)

    if (this.gameOver) {
      ctx.textAlign = 'center'
      ctx.font = 'bold 48px system-ui, sans-serif'
      ctx.fillText('GAME OVER', this.W / 2, this.H / 2 - 24)
      ctx.font = '24px system-ui, sans-serif'
      ctx.fillText('Toque para reiniciar', this.W / 2, this.H / 2 + 24)
    }
  }
}

const game = new ${name.replace(/[^a-zA-Z0-9]/g, '') || 'MyGame'}(document.getElementById('game'))
game.start()
export default game
`

const GAME_TESTS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Testes estruturais do jogo (executáveis em Node sem browser)
const main = readFileSync('src/main.js', 'utf8')
const engine = readFileSync('src/engine.js', 'utf8')

test('engine define game loop com delta time', () => {
  assert.ok(engine.includes('requestAnimationFrame'), 'deve usar requestAnimationFrame')
  assert.ok(engine.includes('update(dt)'), 'deve ter update(dt)')
  assert.ok(engine.includes('render(ctx)'), 'deve ter render(ctx)')
})

test('engine suporta touch controls mobile-first', () => {
  assert.ok(engine.includes('touchstart'), 'deve lidar com touchstart')
  assert.ok(engine.includes('touchmove'), 'deve lidar com touchmove')
})

test('canvas responsivo com devicePixelRatio', () => {
  assert.ok(engine.includes('devicePixelRatio'), 'deve considerar devicePixelRatio')
})

test('jogo possui player, colisão e pontuação', () => {
  assert.ok(main.includes('this.player'), 'deve ter player')
  assert.ok(main.includes('score'), 'deve ter pontuação')
  assert.ok(/coll|hypot|dist/.test(main), 'deve ter colisão')
})

test('áudio implementado sem assets externos', () => {
  assert.ok(engine.includes('AudioContext'), 'deve usar WebAudio')
})

test('HTML é mobile-first', () => {
  const html = readFileSync('index.html', 'utf8')
  assert.ok(html.includes('width=device-width'), 'viewport mobile')
  assert.ok(html.includes('touch-action'), 'touch-action definido')
})
`

const LANDING_HTML = (name: string) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name}</title>
<style>
  :root { --brand: #16a34a; --bg: #0f172a; --fg: #f8fafc; --muted: #94a3b8 }
  * { margin: 0; padding: 0; box-sizing: border-box }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6 }
  .container { max-width: 1080px; margin: 0 auto; padding: 0 20px }
  header { padding: 80px 0 60px; text-align: center }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin-bottom: 16px }
  .highlight { color: var(--brand) }
  .subtitle { color: var(--muted); font-size: clamp(1rem, 2.5vw, 1.25rem); max-width: 640px; margin: 0 auto 32px }
  .cta { display: inline-block; background: var(--brand); color: #fff; text-decoration: none; padding: 16px 36px; border-radius: 12px; font-weight: 700; min-height: 44px }
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; padding: 60px 0 }
  .card { background: #1e293b; border-radius: 16px; padding: 28px }
  .card h3 { margin-bottom: 10px; color: var(--brand) }
  footer { padding: 40px 0; text-align: center; color: var(--muted); font-size: 0.9rem }
</style>
</head>
<body>
  <header class="container">
    <h1>${name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</h1>
    <p class="subtitle">Soluções reais para o seu negócio. Comece hoje e veja resultados.</p>
    <a class="cta" href="#contato">Começar agora</a>
  </header>
  <section class="container features">
    <div class="card"><h3>Rápido</h3><p>Resultados em dias, não meses.</p></div>
    <div class="card"><h3>Moderno</h3><p>Tecnologia atual e responsiva.</p></div>
    <div class="card"><h3>Suporte</h3><p>Acompanhamento contínuo.</p></div>
  </section>
  <footer class="container">© ${new Date().getFullYear()} ${name}</footer>
</body>
</html>
`

const LANDING_TESTS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync('index.html', 'utf8')

test('página possui title e viewport mobile', () => {
  assert.ok(html.includes('<title>'))
  assert.ok(html.includes('width=device-width'))
})

test('layout responsivo com grid auto-fit', () => {
  assert.ok(html.includes('auto-fit'), 'deve usar grid responsivo')
  assert.ok(html.includes('clamp('), 'tipografia fluida com clamp')
})

test('possui CTA acessível (touch-friendly)', () => {
  assert.ok(html.includes('class="cta"'), 'CTA presente')
  assert.ok(html.includes('min-height: 44px'), 'alvo de toque >= 44px')
})
`

const API_SERVER = `import http from 'node:http'

const PORT = process.env.PORT || 3000

const tasks = [
  { id: 1, title: 'Exemplo', done: false },
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, \`http://\${req.headers.host}\`)
  const json = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return json(200, tasks)
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { title } = JSON.parse(body || '{}')
    if (!title) return json(400, { error: 'title obrigatório' })
    const task = { id: tasks.length + 1, title, done: false }
    tasks.push(task)
    return json(201, task)
  }
  return json(404, { error: 'rota não encontrada' })
})

server.listen(PORT, () => console.log('API em http://localhost:' + PORT))
export default server
`

const API_TESTS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync('server.js', 'utf8')

test('API define rotas REST', () => {
  assert.ok(server.includes("'/api/tasks'"), 'rota /api/tasks')
  assert.ok(server.includes('GET'), 'método GET')
  assert.ok(server.includes('POST'), 'método POST')
})

test('API valida input e responde JSON', () => {
  assert.ok(server.includes('title obrigatório'), 'validação de input')
  assert.ok(server.includes('application/json'), 'content-type JSON')
})
`

function pkg(scripts) {
  return JSON.stringify(
    {
      name: 'ai-studio-project',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts,
    },
    null,
    2
  )
}

export const TEMPLATES: Record<string, ProjectTemplate> = {
  MINI_GAME: {
    type: 'MINI_GAME',
    label: 'Mini-Game 2D (Mobile)',
    description: 'Jogo 2D mobile-first com canvas, game loop, touch controls e áudio procedural.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test' }) },
      { path: 'index.html', content: GAME_HTML('Mini Game') },
      { path: 'src/engine.js', content: GAME_ENGINE },
      { path: 'src/main.js', content: GAME_MAIN('MiniGame') },
      { path: 'test/game.test.js', content: GAME_TESTS },
    ],
  },
  GAME_2D: {
    type: 'GAME_2D',
    label: 'Jogo 2D Completo',
    description: 'Base de jogo 2D com engine, entidades, spawn, HUD e testes.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test' }) },
      { path: 'index.html', content: GAME_HTML('Jogo 2D') },
      { path: 'src/engine.js', content: GAME_ENGINE },
      { path: 'src/main.js', content: GAME_MAIN('Game2D') },
      { path: 'test/game.test.js', content: GAME_TESTS },
    ],
  },
  LANDING_PAGE: {
    type: 'LANDING_PAGE',
    label: 'Landing Page',
    description: 'Landing page responsiva, mobile-first, com CTA e testes estruturais.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test' }) },
      { path: 'index.html', content: LANDING_HTML('Minha Empresa') },
      { path: 'test/landing.test.js', content: LANDING_TESTS },
    ],
  },
  WEB_APP: {
    type: 'WEB_APP',
    label: 'Web App',
    description: 'App web vanilla com módulos ES, API local e testes.',
    testCommand: 'node --test test/',
    files: [
      {
        path: 'package.json',
        content: pkg({ test: 'node --test test/', start: 'npx --yes http-server . -p 8080' }),
      },
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Web App</title></head>
<body>
<div id="app"><h1>Web App</h1><p id="status">carregando…</p></div>
<script type="module" src="src/main.js"></script>
</body>
</html>`,
      },
      {
        path: 'src/main.js',
        content: `const el = document.getElementById('status')
el.textContent = 'pronto'
export function greet(name) { return 'Olá, ' + name + '!' }
`,
      },
      {
        path: 'test/app.test.js',
        content: `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const main = readFileSync('src/main.js', 'utf8')
test('app tem módulo e função exportada', () => {
  assert.ok(main.includes('export function'), 'deve exportar função')
})
`,
      },
    ],
  },
  PWA: {
    type: 'PWA',
    label: 'PWA',
    description: 'Progressive Web App com manifest, service worker e shell mobile-first.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test' }) },
      {
        path: 'manifest.json',
        content: JSON.stringify(
          { name: 'My PWA', short_name: 'PWA', start_url: '.', display: 'standalone', background_color: '#0f172a', theme_color: '#16a34a' },
          null,
          2
        ),
      },
      {
        path: 'sw.js',
        content: `self.addEventListener('install', (e) => self.skipWaiting())
self.addEventListener('activate', (e) => self.clients.claim())
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
})
`,
      },
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>PWA</title><link rel="manifest" href="manifest.json"></head>
<body><h1>Meu PWA</h1><script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js')</script></body>
</html>`,
      },
      {
        path: 'test/pwa.test.js',
        content: `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('manifest válido', () => {
  const m = JSON.parse(readFileSync('manifest.json', 'utf8'))
  assert.ok(m.name && m.start_url)
})
test('service worker registra cache', () => {
  const sw = readFileSync('sw.js', 'utf8')
  assert.ok(sw.includes('fetch'))
})
`,
      },
    ],
  },
  API: {
    type: 'API',
    label: 'API REST',
    description: 'API Node.js sem dependências com rotas REST e testes.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test test/', start: 'node server.js' }) },
      { path: 'server.js', content: API_SERVER },
      { path: 'test/api.test.js', content: API_TESTS },
    ],
  },
  EMPTY_PROJECT: {
    type: 'EMPTY_PROJECT',
    label: 'Projeto Vazio',
    description: 'Workspace limpo — os agentes criam a estrutura conforme o pedido.',
    testCommand: 'node --test test/',
    files: [
      { path: 'package.json', content: pkg({ test: 'node --test' }) },
      { path: '.gitkeep', content: '' },
    ],
  },
}

export function getTemplate(type: string): ProjectTemplate {
  return TEMPLATES[type] ?? TEMPLATES.EMPTY_PROJECT
}

export function templateSummaries() {
  return Object.values(TEMPLATES).map((t) => ({
    type: t.type,
    label: t.label,
    description: t.description,
    testCommand: t.testCommand,
  }))
}

export function readmeFor(name: string, type: string, description: string): TemplateFile {
  return { path: 'README.md', content: README_BASE(name, type, description) }
}
