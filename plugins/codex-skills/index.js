import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply as mountFilesystem } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'codex-skill-filesystem'
export const inject = ['skills']

/** Use the same root as Codex, without changing DSH's other skill sources. */
export function discoveryOptions(env = process.env, home = homedir()) {
  const configured = env.CODEX_HOME?.trim()
  const root = configured ? resolve(configured) : join(home, '.codex')
  return {
    providerName: 'codex-skills', includeDefaultRoots: false,
    customSkillDirs: [join(root, 'skills')], watch: true,
  }
}

export function apply(ctx) {
  // Reuse DSH's parser, invocation policies, symlink handling and watchers.
  // A distinct provider name lets it coexist with the preset-local scanner.
  mountFilesystem(ctx, discoveryOptions())
}
