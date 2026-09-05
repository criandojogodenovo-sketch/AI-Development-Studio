// Teste unitário do extractJson/repairJson (réplica exata das funções de base.ts)
function repairJson(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '"') { inString = false; out += ch }
      else if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++ }
      else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += ch
    } else {
      if (ch === '"') { inString = true; out += ch }
      else out += ch
    }
  }
  out = out.replace(/,\s*([}\]])/g, '$1')
  return out
}

function closeTruncatedJson(text) {
  const repaired = repairJson(text)
  let braces = 0, brackets = 0, inString = false
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  let closed = repaired
  if (inString) closed += '"'
  closed += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces))
  return closed
}

function extractJson(text) {
  if (!text) return null
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))
  const thought = trimmed.match(/\{"thought"[\s\S]*\}/)
  if (thought) candidates.push(thought[0])
  const attempts = [...candidates]
  for (const c of candidates) attempts.push(repairJson(c))
  attempts.push(closeTruncatedJson(trimmed))
  for (const c of attempts) {
    if (!c) continue
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { }
  }
  return null
}

// ===== CASOS REAIS OBSERVADOS =====
const tests = [
  {
    name: 'JSON com newlines literais dentro de string (caso real observado)',
    input: '```json\n{\n  "tool": "modify_file",\n  "args": {\n    "path": "src/main.js",\n    "content": "linha1\nlinha2\nlinha3"\n  }\n}\n```',
  },
  {
    name: 'Resposta ReAct com action aninhada',
    input: '{"thought":"vou editar","action":{"tool":"modify_file","args":{"path":"a.js","searchText":"x","replaceText":"y"}}}',
  },
  {
    name: 'JSON truncado (cortado por max_tokens)',
    input: '{"thought":"reescrita completa","action":{"tool":"create_file","args":{"path":"src/game.js","content":"class Game {\n  start() {\n    this.loop()',
  },
  {
    name: 'Top-level tool/args (variação)',
    input: '{"thought":"ler","tool":"read_file","args":{"path":"package.json"}}',
  },
  {
    name: 'JSON direto válido',
    input: '{"final":true,"result":"concluído com testes passando"}',
  },
]

let pass = 0
for (const t of tests) {
  const r = extractJson(t.input)
  const ok = r !== null && typeof r === 'object'
  console.log(ok ? '✅' : '❌', t.name)
  if (ok) {
    pass++
    console.log('   →', JSON.stringify(r).slice(0, 120))
  }
}
console.log(`\n${pass}/${tests.length} casos OK`)
process.exit(pass === tests.length ? 0 : 1)
