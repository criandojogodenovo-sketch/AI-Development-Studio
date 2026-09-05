const ZAI = require('z-ai-web-dev-sdk').default
const fs = require('fs')

async function main() {
  const zai = await ZAI.create()
  const shots = [
    ['01-before-auth.png', 'tela de login/registro (antes das correções)'],
    ['02-before-dashboard.png', 'dashboard após login (antes das correções)'],
    ['03-before-models.png', 'página de modelos de IA (antes das correções)'],
    ['07-before-run.png', 'workspace de projeto com aba de tarefas (antes das correções)'],
  ]
  for (const [file, ctx] of shots) {
    const b64 = fs.readFileSync(`/home/z/my-project/.zscripts/audit/${file}`).toString('base64')
    const res = await zai.chat.completions.create({
      messages: [
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          { type: 'text', text: `Audite visualmente esta ${ctx} de um app web dark-mode. Liste APENAS problemas visuais REAIS e específicos: texto ilegível/baixo contraste, elementos cortados/overflow, sobreposição, alinhamento quebrado, espaçamento inconsistente, botões/inputs mal renderizados, hierarquia confusa, estados vazios mal apresentados, qualquer texto cru tipo "#" ou "**" aparecendo sem renderizar, branding de terceiros (ZAI/Z.ai). Se estiver visualmente OK, diga "OK". Máximo 6 itens, formato curto "elemento → problema".` },
        ]},
      ],
    })
    console.log(`\n===== ${file} =====`)
    console.log(res.choices[0].message.content)
  }
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
