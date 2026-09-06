// Test raw TCP reachability to Neon (5432) — diagnoses P1001
import net from 'node:net'

const hosts = [
  'ep-empty-haze-aegqj51i-pooler.c-2.us-east-2.aws.neon.tech',
  'ep-empty-haze-aegqj51i.c-2.us-east-2.aws.neon.tech',
]

for (const host of hosts) {
  await new Promise((resolve) => {
    const s = net.createConnection({ host, port: 5432, timeout: 8000 })
    s.on('connect', () => { console.log(`CONNECT OK   ${host}:5432`); s.destroy(); resolve() })
    s.on('timeout', () => { console.log(`TIMEOUT     ${host}:5432`); s.destroy(); resolve() })
    s.on('error', (e) => { console.log(`ERROR       ${host}:5432 — ${e.code ?? e.message}`); resolve() })
  })
}
