import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { mimeFor } from '@/lib/studio/projects/workspace'

export const dynamic = 'force-dynamic'

/**
 * GET /api/preview/:projectId/<path> — PREVIEW REAL, PERSISTENTE.
 *
 * - Serve arquivos do DATABASE (sobrevive a instâncias efêmeras)
 * - HTML recebe script de console forwarding (log/warn/error/onerror →
 *   postMessage ao painel Preview do Studio)
 * - Erros 404/render retornam página PREVIEW ERROR acionável:
 *   [Abrir arquivo] [Abrir terminal] [Pedir correção ao Poskli]
 * - Isolado por posse (cookie de sessão HttpOnly — funciona em iframe)
 */

/** Script injetado: encaminha console + erros de runtime ao painel Preview. */
const CONSOLE_BRIDGE = `<script>
(function(){
  var send=function(kind,level,args){try{parent.postMessage({__studioPreview:true,kind:kind,level:level,args:args},'*')}catch(e){}};
  var fmt=function(x){try{return (typeof x==='object'&&x!==null)?JSON.stringify(x).slice(0,600):String(x)}catch(e){return String(x)}};
  ['log','warn','error','info'].forEach(function(level){
    var orig=console[level];
    console[level]=function(){send('console',level,[].map.call(arguments,fmt));try{orig&&orig.apply(console,arguments)}catch(e){}};
  });
  window.addEventListener('error',function(e){
    var f=(e.filename||'').split('/').pop();
    send('error','error',[(e.message||'erro')+(f||e.lineno?(' — '+f+':'+e.lineno):'')]);
  });
  window.addEventListener('unhandledrejection',function(e){
    send('error','error',['Promise rejeitada: '+((e.reason&&e.reason.message)||e.reason||'?')]);
  });
  send('ready','info',[location.pathname]);
})();
</script>`

/** Página de erro acionável (ações via postMessage ao Studio). */
function previewErrorPage(opts: { title: string; file?: string; message: string; hintLine?: string }): string {
  const safeFile = (opts.file ?? '').replace(/[<>"']/g, '')
  const safeMsg = opts.message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PREVIEW ERROR — ${safeFile || opts.title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0c12;color:#e4e4e7;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px}
  .card{max-width:520px;width:100%;background:#141420;border:1px solid #dc26264d;border-radius:14px;padding:28px;box-shadow:0 12px 40px #00000066}
  .badge{display:inline-flex;align-items:center;gap:6px;background:#dc26261a;color:#f87171;border:1px solid #dc26264d;font-size:11px;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:999px;margin-bottom:14px}
  h1{font-size:16px;color:#fafafa;margin-bottom:10px}
  .file{font-family:ui-monospace,monospace;font-size:13px;color:#fbbf24;margin-bottom:8px;word-break:break-all}
  .msg{font-family:ui-monospace,monospace;font-size:12px;color:#a1a1aa;background:#0c0c12;border:1px solid #27272a;border-radius:8px;padding:10px 12px;margin-bottom:18px;white-space:pre-wrap;word-break:break-word}
  .actions{display:flex;flex-wrap:wrap;gap:8px}
  button{flex:1;min-width:130px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 12px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#e4e4e7;font-size:12.5px;font-weight:500;cursor:pointer;transition:all .15s}
  button:hover{background:#27272a;border-color:#52525b}
  button.primary{background:#059669;border-color:#059669;color:#fff}
  button.primary:hover{background:#10b981}
</style>
</head>
<body>
  <div class="card">
    <span class="badge">⚠ PREVIEW ERROR</span>
    <h1>${opts.title}</h1>
    ${safeFile ? `<div class="file">${safeFile}${opts.hintLine ? ':' + opts.hintLine : ''}</div>` : ''}
    <div class="msg">${safeMsg}</div>
    <div class="actions">
      ${safeFile ? `<button onclick="parent.postMessage({__studioAction:'open-file',path:'${safeFile}'},'*')">Abrir arquivo</button>` : ''}
      <button onclick="parent.postMessage({__studioAction:'open-terminal'},'*')">Abrir terminal</button>
      <button class="primary" onclick="parent.postMessage({__studioAction:'ask-poskli',message:'Corrija o erro do preview: ${safeMsg.slice(0, 200).replace(/'/g, "\\'")}'},'*')">Pedir correção ao Poskli</button>
    </div>
  </div>
</body>
</html>`
}

function injectConsole(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${CONSOLE_BRIDGE}`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${CONSOLE_BRIDGE}`)
  return CONSOLE_BRIDGE + html
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const { projectId, path: segments } = await params
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const relPath = (segments ?? []).join('/')
  const candidates = relPath
    ? [relPath, `${relPath}/index.html`, relPath.endsWith('.html') ? relPath : `${relPath}.html`]
    : ['index.html']

  for (const candidate of candidates) {
    const file = await workspaceProvider.readFile(projectId, candidate).catch(() => null)
    if (!file) continue
    const contentType = mimeFor(candidate)

    if (contentType.startsWith('text/html')) {
      if (file.encoding !== 'utf8') continue
      return new NextResponse(injectConsole(file.content), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    const body =
      file.encoding === 'base64'
        ? new Uint8Array(Buffer.from(file.content, 'base64'))
        : new TextEncoder().encode(file.content)
    return new NextResponse(body, {
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  // 404 — página de erro acionável
  return new NextResponse(
    previewErrorPage({
      title: 'Arquivo não encontrado no preview',
      file: relPath || 'index.html',
      message: relPath
        ? `"${relPath}" não existe no workspace. Verifique o nome do arquivo no Explorer — ou peça ao Poskli para criar/ajustar o ponto de entrada.`
        : 'Nenhum "index.html" na raiz do projeto. Projetos web precisam de um index.html para o preview funcionar.',
    }),
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  )
}
