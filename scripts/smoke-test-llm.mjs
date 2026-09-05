import ZAI from 'z-ai-web-dev-sdk';
try {
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'user', content: 'Responda apenas com o JSON: {"ok":true,"engine":"operational"}' }
    ],
    thinking: { type: 'disabled' }
  });
  const content = completion?.choices?.[0]?.message?.content ?? 'SEM CONTEUDO';
  console.log('RESPOSTA:', String(content).slice(0, 200));
  console.log('USO:', JSON.stringify(completion?.usage ?? 'n/d'));
} catch (e) {
  console.error('FALHA:', e.message);
  process.exit(1);
}
