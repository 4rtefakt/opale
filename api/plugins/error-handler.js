import fp from 'fastify-plugin'

// Handler d'erreur global — harmonise le format des throw/reject non
// capturés vers `{ error: <message> }`, cohérent avec les
// `reply.code(NNN).send({ error: '...' })` posés partout dans les routes.
//
// Trois cas distincts :
//   1. Erreurs Fastify avec statusCode (validation schéma, body parser…)
//      → on relaie le statusCode et le message.
//   2. Erreurs métier connues (404, 409, 422 throw via libs) → idem si
//      `err.statusCode` est posé.
//   3. Erreurs imprévues (bugs, DB down…) → 500 avec un message générique
//      pour ne pas leaker la stack côté client. Log complet côté serveur
//      via req.log.error (le request id est ajouté auto).
//
// La stack reste loggée intégralement côté serveur — pas de perte de
// signal pour le debug.
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((err, req, reply) => {
    const status = Number(err.statusCode) || 500
    // Bug serveur : on logge la stack complète et on renvoie un message
    // générique. Pour les 4xx, on relaie le message tel quel — c'est de
    // l'info utilisateur côté API.
    if (status >= 500) {
      req.log.error({ err, route: req.routeOptions?.url, method: req.method }, 'unhandled error')
      return reply.code(status).send({ error: 'Erreur interne' })
    }
    // 4xx — peut être levé par la validation Fastify (avec un message
    // sérialisé en français pas idéal, ex: "body must have required
    // property 'hostname'"), ou par un `throw` qui pose `err.statusCode`.
    // On le relaie tel quel — les routes du projet utilisent déjà
    // `reply.code(...).send({ error: ... })` pour les cas contrôlés,
    // donc cet handler attrape surtout l'inattendu validation.
    req.log.warn({ err: err.message, route: req.routeOptions?.url, status }, 'request error')
    reply.code(status).send({ error: err.message || 'Requête invalide' })
  })
}

export default fp(errorHandlerPlugin)
