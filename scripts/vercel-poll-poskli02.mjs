#!/usr/bin/env node
// Poll Vercel deployment for commit sha until READY (Poskli 0.2)
const TOKEN = process.env.VERCEL_TOKEN
const PROJECT = 'prj_JlAHgua53UYdAnmDhaLykQSeg0CW'
const TEAM = 'team_UwVqmKiOfeuCvwjfmZl8ryPr'
const SHA = process.argv[2] ?? '351e3ad'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let deployment = null
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&limit=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const data = await res.json()
    const match = (data.deployments ?? []).find((d) => (d.meta?.githubCommitSha ?? '').startsWith(SHA))
    if (match) {
      deployment = match
      console.log(`deployment ${match.id} — ${match.readyState} (${match.url})`)
      if (match.readyState === 'READY' || match.readyState === 'ERROR' || match.readyState === 'CANCELED') break
    } else {
      console.log(`aguardando deployment do sha ${SHA}...`)
    }
    await sleep(10_000)
  }
  if (!deployment) { console.error('deployment não encontrado'); process.exit(1) }
  if (deployment.readyState !== 'READY') {
    console.error('FALHOU:', deployment.readyState)
    process.exit(2)
  }
  console.log('READY ✓')
  console.log('url:', deployment.url)
  console.log('alias: ai-development-studio-gamma.vercel.app')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
