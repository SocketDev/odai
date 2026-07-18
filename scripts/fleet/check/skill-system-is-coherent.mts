#!/usr/bin/env node
/**
 * Enforce catalog coverage and mandatory cross-skill handoff links.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { FLEET_SKILL_CATALOG, SKILL_HANDOFFS } from '../lib/skill-system.mts'
import { REPO_ROOT } from '../paths.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

const logger = getDefaultLogger()

export function findSkillSystemDefects(
  names: readonly string[],
  sources: Readonly<Record<string, string>>,
): string[] {
  const actual = new Set(names)
  const catalog = new Set(Object.keys(FLEET_SKILL_CATALOG))
  const defects = [
    ...[...actual]
      .filter(name => !catalog.has(name))
      .map(name => `uncatalogued skill: ${name}`),
    ...[...catalog]
      .filter(name => !actual.has(name))
      .map(name => `missing skill: ${name}`),
  ]
  for (const [source, targets] of Object.entries(SKILL_HANDOFFS)) {
    for (const target of targets) {
      if (!sources[source]?.includes(`${target}/SKILL.md`)) {
        defects.push(`missing handoff: ${source} → ${target}`)
      }
    }
  }
  return defects.toSorted()
}

async function main(): Promise<void> {
  const root = path.join(REPO_ROOT, '.claude/skills/fleet')
  const names = readdirSync(root).filter(name => !name.startsWith('_'))
  const sources = Object.fromEntries(
    names.map(name => {
      const file = path.join(root, name, 'SKILL.md')
      return [name, existsSync(file) ? readFileSync(file, 'utf8') : '']
    }),
  )
  const defects = findSkillSystemDefects(names, sources)
  if (defects.length === 0) {
    logger.success('fleet skill catalog and handoff graph are coherent.')
    return
  }
  logger.error('fleet skill-system defects:')
  for (const defect of defects) logger.error(`  ${defect}`)
  process.exitCode = 1
}

if (isMainModule(import.meta.url))
  main().catch(error => {
    logger.error(errorMessage(error))
    process.exitCode = 1
  })
