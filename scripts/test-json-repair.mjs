import ZAI from 'z-ai-web-dev-sdk'
const zai = await ZAI.create()
// força truncamento com max_tokens baixo para ver finish_reason
const r = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Escreva um JSON {"tool":"modify_file","args":{"content":"linha1\\nlinha2\\nlinha3"}} com quebras de linha REAIS dentro da string content (não escapadas), exatamente assim' }],
  thinking: { type: 'disabled' },
  max_tokens: 200,
})
console.log('FINISH_REASON:', JSON.stringify(r.choices?.[0]?.finish_reason))
console.log('CONTENT (bruto):')
console.log(r.choices?.[0]?.message?.content)
try {
  JSON.parse(r.choices[0].message.content)
  console.log('PARSE: OK')
} catch (e) {
  console.log('PARSE FALHOU:', e.message.slice(0, 80))
}
