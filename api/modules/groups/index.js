import groupsRoute       from './routes/groups.js'
import nativeGroupsRoute  from './routes/native-groups.js'
import { startGroupSyncWorker } from './lib/group-sync.js'
import { getGroupDeviceHostnames, getGroupUserIds } from '../core/lib/graph.js'

export default {
  name: 'groups',
  requires: ['core'],
  async register(fastify) {
    // Décorateur graph partagé — utilisé par packages/scripts pour résoudre
    // des hostnames/users à partir d'un groupId. Vit ici parce que c'est la
    // surface "groupes" d'Opale. Si groups est désactivé, ce décorateur
    // n'existe pas (à wrapper côté consommateurs si nécessaire).
    fastify.decorate('graph', { getGroupDeviceHostnames, getGroupUserIds })

    await fastify.register(groupsRoute,       { prefix: '/api/groups' })
    await fastify.register(nativeGroupsRoute, { prefix: '/api/groups' })
  },
  startWorkers(fastify) {
    startGroupSyncWorker(fastify.db, fastify.log)
  }
}
