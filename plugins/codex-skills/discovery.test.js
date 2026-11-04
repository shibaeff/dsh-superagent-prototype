import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, discoveryOptions } from './index.js'

const skill = (name, extra = '', body = 'Instructions') => `---\nname: ${name}\ndescription: Test ${name}\n${extra}---\n${body}\n`
async function writeSkill(root, name, content = skill(name)) {
  const directory = join(root, 'skills', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
}

async function withProvider(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex skill discovery '))
  const before = process.env.CODEX_HOME
  process.env.CODEX_HOME = root
  const lifetime = new AbortController()
  let provider, invalidations = 0
  const warnings = []
  const ctx = {
    get: () => undefined, effect: () => {}, on: () => {},
    logger: { warn: warning => warnings.push(warning) },
    skills: { registerProvider: create => {
      provider = create({ signal: lifetime.signal, invalidate: () => { invalidations++ } })
    } },
  }
  apply(ctx)
  const options = { cwd: root, signal: lifetime.signal }
  try { await run({ root, provider, options, warnings, invalidations: () => invalidations }) }
  finally {
    lifetime.abort()
    await provider.dispose()
    if (before === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = before
    await rm(root, { recursive: true, force: true })
  }
}
const candidates = result => Array.isArray(result) ? result : result.candidates

test('default path and CODEX_HOME resolve without replacing normal DSH sources', () => {
  assert.deepEqual(discoveryOptions({}, '/example').customSkillDirs, ['/example/.codex/skills'])
  const options = discoveryOptions({ CODEX_HOME: '/custom/codex' }, '/example')
  assert.deepEqual(options.customSkillDirs, ['/custom/codex/skills'])
  assert.equal(options.providerName, 'codex-skills')
  assert.equal(options.includeDefaultRoots, false)
  assert.equal(options.watch, true)
})

test('real DSH parser discovers and loads directory, flat and symlinked skills', async () => {
  await withProvider(async ({ root, provider, options }) => {
    await writeSkill(root, 'aoe-review', skill('aoe-review', '', 'Review through Agent of Empires.'))
    await writeFile(join(root, 'skills/flat-skill.md'), skill('flat-skill'))
    await mkdir(join(root, 'external'))
    await writeFile(join(root, 'external/SKILL.md'), skill('linked-skill'))
    await symlink(join(root, 'external'), join(root, 'skills/linked-skill'))
    const list = candidates(await provider.list(options))
    assert.deepEqual(list.map(item => item.name).sort(), ['aoe-review', 'flat-skill', 'linked-skill'])
    const loaded = await provider.get(list.find(item => item.name === 'aoe-review'), options)
    assert.match(loaded.content, /Review through Agent of Empires/)
    assert.equal(loaded.provider, 'codex-skills')
    await writeFile(join(root, 'skills/aoe-review/SKILL.md'), skill('aoe-review', '', 'Updated instructions'))
    assert.match((await provider.get(list.find(item => item.name === 'aoe-review'), options)).content, /Updated instructions/)
  })
})

test('invocation restrictions survive discovery and malformed skills are skipped', async () => {
  await withProvider(async ({ root, provider, options, warnings }) => {
    await writeSkill(root, 'manual-only', skill('manual-only', 'disable-model-invocation: true\n'))
    await writeSkill(root, 'invalid', 'not skill frontmatter')
    const list = candidates(await provider.list(options))
    assert.equal(list.length, 1)
    assert.equal((await provider.get(list[0], options)).invocation.modelInvocable, false)
    assert.ok(warnings.some(warning => warning.includes('frontmatter')))
  })
})

test('watcher invalidates discovery after an external skill is added', async () => {
  await withProvider(async ({ root, provider, options, invalidations }) => {
    await mkdir(join(root, 'skills'))
    await provider.list(options)
    const before = invalidations()
    await writeSkill(root, 'new-skill')
    const deadline = Date.now() + 5000
    while (invalidations() === before && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(invalidations() > before, 'actual DSH filesystem watcher must invalidate the catalog')
    assert.ok(candidates(await provider.list(options)).some(item => item.name === 'new-skill'))
  })
})
