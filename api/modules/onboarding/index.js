import onboardingRoute from './routes/onboarding.js'

export default {
  name: 'onboarding',
  requires: ['core', 'inventory'],
  async register(fastify) {
    await fastify.register(onboardingRoute, { prefix: '/api/onboarding' })
  }
}
