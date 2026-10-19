export const meta = {
  name: 'security-review',
  description: 'Map the attack surface, hunt exploitable bugs per area, adversarially verify each, report ranked findings',
  whenToUse: 'Before an external audit or pen test, or after large auth/ingest changes. Read-only: never edits, deploys, or calls non-local URLs. args: {paths?: string[], focus?: string, maxAreas?: number}',
  phases: [
    { title: 'Map', detail: 'one agent maps trust boundaries into review areas' },
    { title: 'Hunt', detail: 'one adversarial reviewer per area' },
    { title: 'Verify', detail: 'one skeptic per area tries to refute its findings' },
    { title: 'Report', detail: 'rank, dedupe, list what was not covered' },
  ],
}

const opts = args || {}
const PATHS = opts.paths && opts.paths.length ? opts.paths.join(', ') : 'the whole repository'
const FOCUS = opts.focus ? `Extra focus from the owner: ${opts.focus}.` : ''
const MAX_AREAS = opts.maxAreas || 4

const RULES = `Read-only. Do NOT edit files, deploy, push, or send requests to any non-local URL.
You may run the project's own tests or throwaway scripts under /tmp to confirm a finding.
Read the project's agent guide (AGENTS.md / CLAUDE.md) for stated security invariants.`

const AREAS = {
  type: 'object',
  required: ['system', 'areas'],
  properties: {
    system: { type: 'string', description: 'Two sentences: what the system is and what data is sensitive' },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'files', 'boundary', 'questions'],
        properties: {
          name: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          boundary: { type: 'string', description: 'Which trust boundary this area sits on and who is on the other side' },
          questions: { type: 'array', items: { type: 'string' }, description: 'Concrete attacks worth trying here' },
        },
      },
    },
    invariants: { type: 'array', items: { type: 'string' }, description: 'Security invariants the docs claim' },
  },
}

const FINDING = {
  type: 'object',
  required: ['title', 'severity', 'location', 'attack', 'fix'],
  properties: {
    title: { type: 'string' },
    severity: { enum: ['critical', 'high', 'medium', 'low', 'info'] },
    location: { type: 'string', description: 'path:line' },
    attack: { type: 'string', description: 'Who, with what access, sends what, and gets what' },
    fix: { type: 'string', description: 'One line' },
  },
}
const FINDINGS = {
  type: 'object',
  required: ['findings', 'ruled_out'],
  properties: {
    findings: { type: 'array', items: FINDING },
    ruled_out: { type: 'array', items: { type: 'string' }, description: 'Attacks tried and why they fail' },
    invariants_checked: { type: 'array', items: { type: 'string' } },
  },
}
const VERDICTS = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'status', 'severity', 'evidence'],
        properties: {
          index: { type: 'integer' },
          status: { enum: ['confirmed', 'plausible', 'refuted'] },
          severity: { enum: ['critical', 'high', 'medium', 'low', 'info'] },
          evidence: { type: 'string', description: 'What you read or ran; for refuted, the check that blocks the attack' },
        },
      },
    },
  },
}

phase('Map')
const map = await agent(
  `Map the attack surface of ${PATHS} for a security review. ${FOCUS}
${RULES}
List entry points (HTTP routes, CLIs, scripts, IPC, file inputs), the auth on each, where untrusted data is stored and later rendered or executed, and secrets handling.
Group them into at most ${MAX_AREAS} review areas, each on one trust boundary, so a single reviewer can read all its files. Cover every boundary; merge rather than drop.`,
  { label: 'map-surface', schema: AREAS },
)
if (!map || !map.areas.length) return { error: 'mapping produced no areas' }
const areas = map.areas.slice(0, MAX_AREAS)
if (map.areas.length > MAX_AREAS) log(`Dropped areas beyond ${MAX_AREAS}: ${map.areas.slice(MAX_AREAS).map(a => a.name).join(', ')}`)
log(`${areas.length} areas: ${areas.map(a => a.name).join(', ')}`)

const results = await pipeline(
  areas,
  area => agent(
    `Adversarial security review of one area. System: ${map.system}
Area: ${area.name}. Boundary: ${area.boundary}
Files: ${area.files.join(', ')} (follow calls into other files when the path goes there).
Start from these attacks, then find your own: ${area.questions.join(' | ')}
Claimed invariants to check where they touch this area: ${(map.invariants || []).join(' | ') || 'none stated'}
${FOCUS}
${RULES}
Report only issues you can tie to a concrete attack: inputs, required access, result. Severity reflects real exploitability for this system's actual users, not theoretical worst case. List what you ruled out.`,
    { label: `hunt:${area.name}`, phase: 'Hunt', schema: FINDINGS },
  ),
  (found, area) => {
    if (!found || !found.findings.length) return { area: area.name, confirmed: [], refuted: [], ruled_out: found ? found.ruled_out : [], invariants_checked: found ? found.invariants_checked || [] : [] }
    const list = found.findings.map((f, i) => `[${i}] ${f.severity} ${f.location} — ${f.title}\nAttack: ${f.attack}`).join('\n\n')
    return agent(
      `You are a skeptic. Try to REFUTE each security finding below by reading the full code path: look for an earlier check, a platform guarantee, or a missing precondition that blocks it.
Mark confirmed only if you traced the whole path (or reproduced it locally); plausible if the path holds but impact depends on something you cannot check; refuted otherwise. Re-rate severity honestly.
${RULES}

${list}`,
      { label: `verify:${area.name}`, phase: 'Verify', schema: VERDICTS },
    ).then(v => {
      const byIndex = new Map((v ? v.verdicts : []).map(x => [x.index, x]))
      const judged = found.findings.map((f, i) => {
        const x = byIndex.get(i)
        return x ? { ...f, severity: x.severity, status: x.status, evidence: x.evidence, area: area.name } : { ...f, status: 'unverified', evidence: 'verifier returned no verdict', area: area.name }
      })
      return {
        area: area.name,
        confirmed: judged.filter(f => f.status !== 'refuted'),
        refuted: judged.filter(f => f.status === 'refuted'),
        ruled_out: found.ruled_out,
        invariants_checked: found.invariants_checked || [],
      }
    })
  },
)

phase('Report')
const done = results.filter(Boolean)
const missing = areas.filter(a => !done.some(r => r.area === a.name)).map(a => a.name)
if (missing.length) log(`No result for: ${missing.join(', ')}`)
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const findings = done.flatMap(r => r.confirmed).sort((a, b) => RANK[a.severity] - RANK[b.severity])

const report = await agent(
  `Write the final security review report in Markdown from these verified findings. Merge duplicates that share a root cause. Most severe first; for each: severity, status (confirmed/plausible/unverified), location, the attack in 2-3 numbered steps, fix. Then "Ruled out" and "Invariants checked" as short bullet lists, then "Not covered": areas with no result (${missing.join(', ') || 'none'}) and anything the reviewers said they could not check. No praise, no recap of method.

System: ${map.system}
Findings: ${JSON.stringify(findings)}
Refuted (mention only in one line each under Ruled out): ${JSON.stringify(done.flatMap(r => r.refuted).map(f => `${f.title}: ${f.evidence}`))}
Ruled out: ${JSON.stringify(done.flatMap(r => r.ruled_out))}
Invariants checked: ${JSON.stringify(done.flatMap(r => r.invariants_checked))}`,
  { label: 'report', effort: 'low' },
)

return { report, findings, areas: areas.map(a => a.name), not_covered: missing }
