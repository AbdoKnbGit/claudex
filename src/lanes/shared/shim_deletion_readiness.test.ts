/**
 * Phase-7 shim-deletion readiness check.
 *
 * Runs periodically (locally + in CI) to tell us when the legacy
 * `src/services/api/providers/*_provider.ts` + `src/services/api/adapters/*`
 * files become safe to delete. Each assertion is a GATE — failing
 * means DON'T delete yet; passing across the board means Phase 7 can
 * ship.
 *
 * The test is INTENTIONALLY lenient on "still passes". It reports
 * findings rather than failing hard, so it stays green in normal
 * development. Use it to check readiness before a cleanup PR.
 *
 * Run:  bun run src/lanes/shared/shim_deletion_readiness.test.ts
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

let findings: string[] = []

function report(status: 'PASS' | 'HOLD' | '  -', area: string, detail: string): void {
  findings.push(`  ${status}  ${area.padEnd(40)} ${detail}`)
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...listTs(full))
    else if (s.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full)
  }
  return out
}

function grep(files: string[], pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = []
  for (const f of files) {
    const lines = readFileSync(f, 'utf-8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i] ?? '')) {
        hits.push({ file: f, line: i + 1, text: lines[i] ?? '' })
      }
    }
  }
  return hits
}

function main(): void {
  console.log('shim deletion readiness:')
  console.log('')

  const srcFiles = listTs(join(ROOT, 'src'))
    .filter(f => !f.includes('shim_deletion_readiness')
      // The deprecation guide itself references adapters/ — skip.
      && !f.endsWith('DEPRECATED.md'))

  // ── Gate 1 — native lane default ON ─────────────────────────────
  // providerShim._nativeLaneEnabledFor returns true by default; we
  // check that the source no longer treats any lane as opt-in.
  const shim = readFileSync(join(ROOT, 'src/services/api/providers/providerShim.ts'), 'utf-8')
  if (/default ON/i.test(shim) && /return true\s*\/\/\s*default ON/i.test(shim)) {
    report('PASS', 'native lanes default-on', 'providerShim._nativeLaneEnabledFor defaults to true')
  } else {
    report('HOLD', 'native lanes default-on', 'providerShim default-on wording drifted — re-verify')
  }

  // ── Gate 2 — adapter imports outside the adapters/ directory ────
  const adapterImports = grep(
    srcFiles.filter(f => !f.includes('services/api/adapters/')),
    /from\s+['"][^'"]*services\/api\/adapters\//,
  )
  if (adapterImports.length === 0) {
    report('PASS', 'no adapter imports outside', 'safe to delete adapters/ when providers deleted')
  } else {
    report('HOLD', 'adapter imports outside', `${adapterImports.length} import(s) still reach into adapters/`)
    for (const hit of adapterImports.slice(0, 5)) {
      const rel = hit.file.replace(ROOT, '.').replace(/\\/g, '/')
      report('  -', rel, `L${hit.line}: ${hit.text.trim().slice(0, 90)}`)
    }
  }

  // ── Gate 3 — legacy provider imports outside provider files ─────
  // Matches BOTH `from 'src/services/api/providers/<name>'` AND
  // relative `from './<name>.js'` forms (the latter is how
  // providerShim.ts imports its siblings). Without the relative form
  // the readiness report lied and said providers were unused.
  const legacyProviders = [
    'gemini_provider', 'openai_provider', 'deepseek_provider',
    'groq_provider', 'nim_provider', 'ollama_provider', 'openrouter_provider',
  ]
  for (const prov of legacyProviders) {
    const hits = grep(
      srcFiles.filter(f => !f.endsWith(`${prov}.ts`)),
      new RegExp(`from\\s+['"][^'"]*(providers/|\\./)${prov}(\\.js)?['"]`),
    )
    if (hits.length === 0) {
      report('PASS', `providers/${prov}.ts unused`, 'safe to delete')
    } else {
      report('HOLD', `providers/${prov}.ts used`, `${hits.length} import(s) remain`)
      for (const hit of hits.slice(0, 3)) {
        const rel = hit.file.replace(ROOT, '.').replace(/\\/g, '/')
        report('  -', rel, `L${hit.line}: ${hit.text.trim().slice(0, 90)}`)
      }
    }
  }

  // ── Gate 4 — dispatcher's isAnthropicModel early return ─────────
  // Phase 7 calls for removing this special case once Claude lane
  // actually handles Claude requests. For now the special case must
  // remain (Claude lane is registration-only).
  const dispatcher = readFileSync(join(ROOT, 'src/lanes/dispatcher.ts'), 'utf-8')
  if (/isAnthropicModel/.test(dispatcher)) {
    report('HOLD', 'dispatcher isAnthropicModel', 'special case present — remove only when Claude lane is wired')
  } else {
    report('PASS', 'dispatcher isAnthropicModel', 'special case removed — Claude lane owns its own routing')
  }

  // ── Gate 5 — Lane.run() / streamAsProvider collapse ─────────────
  const types = readFileSync(join(ROOT, 'src/lanes/types.ts'), 'utf-8')
  const hasBoth = /streamAsProvider\?\(/.test(types) && /run\(context:/.test(types)
  if (hasBoth) {
    report('HOLD', 'Lane.run/streamAsProvider split', 'both methods still in the Lane interface — collapse before Phase 7')
  } else {
    report('PASS', 'Lane interface collapsed', 'single entry point')
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(findings.join('\n'))
  console.log('')
  const holds = findings.filter(f => f.includes('HOLD  ')).length
  const passes = findings.filter(f => f.includes('PASS  ')).length
  console.log(`${passes} pass, ${holds} hold`)
  console.log('')
  if (holds > 0) {
    console.log('Shim NOT ready for deletion. Resolve the HOLDs above first.')
  } else {
    console.log('Shim READY for deletion. Run the Phase-7 cleanup PR.')
  }

  // Never fail the process — this is a readiness report, not a gate
  // on normal CI. When we're actually ready to delete, the cleanup
  // PR does the deletion + an explicit grep assertion.
  process.exit(0)
}

main()
