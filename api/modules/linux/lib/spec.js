import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

let spec
export function loadSpec() {
  return spec ??= parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'))
}

// Les objets sont fusionnés récursivement ; les tableaux et scalaires frères priment.
function merge(target, siblings) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(target) || !object(siblings)) return siblings
  return Object.fromEntries(Object.entries({ ...target, ...siblings }).map(([key, value]) =>
    [key, Object.hasOwn(siblings, key) ? merge(target[key], value) : value]))
}

function resolve(node, section, seen) {
  const ref = node.$ref
  const name = typeof ref === 'string' && ref.match(new RegExp(`^#/components/${section}/([A-Za-z0-9_]+)$`))?.[1]
  if (!name) throw new Error(`Référence non prise en charge : ${ref}`)
  if (seen.has(ref)) throw new Error(`Référence cyclique : ${ref}`)
  const target = loadSpec().components[section]?.[name]
  if (!target) throw new Error(`Référence inconnue : ${ref}`)
  const next = new Set([...seen, ref])
  const { $ref, ...siblings } = node
  const resolved = section === 'schemas' ? deref(target, next)
    : target.$ref ? resolve(target, section, next) : target
  return merge(resolved, section === 'schemas' ? deref(siblings, seen) : siblings)
}

export function deref(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map(value => deref(value, seen))
  if (!node || typeof node !== 'object') return node
  if (Object.hasOwn(node, '$ref')) return resolve(node, 'schemas', seen)
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, deref(value, seen)]))
}

export function operations() {
  return Object.entries(loadSpec().paths).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].filter(method => item[method]).map(method => {
      const op = item[method]
      return {
        operationId: op.operationId, method, path,
        module: op['x-opale-module'] ?? 'linux', raw: !!op['x-opale-raw'],
        interactive: !!op['x-opale-interactive'], rateLimit: op['x-opale-rate-limit'] ?? null,
        fastifyUrl: '/api' + path.replace(/\{([^}]+)\}/g, ':$1'),
      }
    }))
}

// Schéma Fastify construit uniquement à partir du contrat OpenAPI.
export function schemaFor(operationId) {
  const found = operations().find(op => op.operationId === operationId)
  if (!found) throw new Error(`Opération inconnue : ${operationId}`)
  const item = loadSpec().paths[found.path]
  const op = item[found.method]
  const schema = {}
  // Un paramètre d'opération remplace celui du chemin de même nom et emplacement.
  const params = new Map([...(item.parameters ?? []), ...(op.parameters ?? [])].map(p => [`${p.in}:${p.name}`, p]))
  for (const [location, key] of [['path', 'params'], ['query', 'querystring'], ['header', 'headers']]) {
    const selected = [...params.values()].filter(p => p.in === location)
    if (!selected.length) continue
    const name = p => location === 'header' ? p.name.toLowerCase() : p.name
    schema[key] = { type: 'object', properties: Object.fromEntries(selected.map(p => [name(p), deref(p.schema)])) }
    const required = selected.filter(p => p.required).map(name)
    if (required.length) schema[key].required = required
  }
  const body = op.requestBody?.content?.['application/json']?.schema
  if (body !== undefined) schema.body = deref(body)
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    const resolved = response.$ref ? resolve(response, 'responses', new Set()) : response
    const json = resolved.content?.['application/json']?.schema
    if (json !== undefined) (schema.response ??= {})[code] = deref(json)
  }
  return schema
}

export function auditActions() {
  return loadSpec().info['x-opale-audit-actions']
}
