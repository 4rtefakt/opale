// Loader de modules pour Opale.
//
// Charge les modules activés depuis modules.config.js, valide leur graphe de
// dépendances, puis appelle leur `register(fastify)` dans l'ordre topologique.
// Les workers (timers, queues) sont démarrés après listen() via startWorkers().

import { modulesConfig as defaultConfig } from '../modules.config.js'

const FORCED_ON = ['core'] // ne peut pas être désactivé

export async function loadModules(fastify, config = defaultConfig) {
  const enabled = Object.entries(config)
    .filter(([, on]) => on)
    .map(([name]) => name)

  for (const forced of FORCED_ON) {
    if (!enabled.includes(forced)) {
      throw new Error(`Module '${forced}' ne peut pas être désactivé`)
    }
  }

  const modules = {}
  for (const name of enabled) {
    const mod = await import(`../modules/${name}/index.js`)
    if (!mod.default || mod.default.name !== name) {
      throw new Error(`Module ${name} : index.js doit exporter default { name: '${name}', ... }`)
    }
    modules[name] = mod.default
  }

  for (const m of Object.values(modules)) {
    for (const dep of m.requires || []) {
      if (!modules[dep]) {
        throw new Error(
          `Module '${m.name}' requiert '${dep}' mais '${dep}' est désactivé. ` +
          `Activez-le dans modules.config.js ou désactivez '${m.name}'.`
        )
      }
    }
  }

  const order = topoSort(modules)

  for (const name of order) {
    const m = modules[name]
    fastify.log.info(`[modules] register '${m.name}'`)
    await m.register(fastify)
  }

  return modules
}

export function startModuleWorkers(modules, fastify) {
  for (const m of Object.values(modules)) {
    if (typeof m.startWorkers === 'function') {
      fastify.log.info(`[modules] startWorkers '${m.name}'`)
      m.startWorkers(fastify)
    }
  }
}

export function enabledModuleNames(config = defaultConfig) {
  return Object.entries(config)
    .filter(([, on]) => on)
    .map(([name]) => name)
}

function topoSort(modules) {
  const visited = new Set()
  const result = []
  const visiting = new Set()

  function visit(name) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(`Cycle de dépendances détecté impliquant le module '${name}'`)
    }
    visiting.add(name)
    const m = modules[name]
    for (const dep of m.requires || []) visit(dep)
    visiting.delete(name)
    visited.add(name)
    result.push(name)
  }

  for (const name of Object.keys(modules)) visit(name)
  return result
}
