const test = require('node:test')
const assert = require('node:assert/strict')

const {
  runBackgroundStartup,
  scheduleBackgroundStartup
} = require('../Utilities/Startup.js')

function createDependencies(overrides = {}) {
  const events = []
  const channel = {
    guideGenerator: {
      invalidateCache: () => events.push('invalidate')
    }
  }
  const channelPool = {
    queue: [channel],
    startBroadcast: () => events.push('broadcast'),
    setStartupStatus: (state, error) => {
      events.push(['status', state, error?.message])
    },
    ...overrides.channelPool
  }
  const dependencies = {
    migrateAll: () => events.push('migrate'),
    backfillDurations: () => events.push('backfill'),
    log: () => {},
    yieldToEventLoop: async () => events.push('yield'),
    ...overrides,
    channelPool,
    preGenerator: {
      queueChannel: () => events.push('queue'),
      startGeneration: () => {
        events.push('generate')
        return Promise.resolve()
      },
      ...overrides.preGenerator
    }
  }

  return { dependencies, events }
}

async function runScheduledFailure(overrides) {
  let scheduledTask
  const { dependencies, events } = createDependencies({
    ...overrides,
    schedule: task => {
      scheduledTask = task
    }
  })

  scheduleBackgroundStartup(dependencies)
  scheduledTask()
  await new Promise(resolve => setImmediate(resolve))

  return events
}

test('runs migration and broadcast startup in order', async () => {
  const { dependencies, events } = createDependencies()

  await runBackgroundStartup(dependencies)
  await Promise.resolve()

  assert.deepEqual(events, [
    'migrate',
    'backfill',
    'invalidate',
    'yield',
    'queue',
    'broadcast',
    ['status', 'ready', undefined],
    'generate'
  ])
})

test('reports migration failures as degraded', async () => {
  const error = new Error('database unavailable')
  const events = await runScheduledFailure({
    migrateAll: () => {
      throw error
    }
  })

  assert.deepEqual(events, [
    ['status', 'degraded', 'database unavailable']
  ])
})

test('reports deferred channel queue failures as degraded', async () => {
  const error = new Error('guide generation failed')
  const events = await runScheduledFailure({
    preGenerator: {
      queueChannel: () => {
        throw error
      }
    }
  })

  assert.deepEqual(events.at(-1), [
    'status',
    'degraded',
    'guide generation failed'
  ])
  assert.equal(events.includes('broadcast'), false)
})

test('reports broadcast startup failures as degraded', async () => {
  const error = new Error('filesystem unavailable')
  const events = await runScheduledFailure({
    channelPool: {
      startBroadcast: () => {
        throw error
      }
    }
  })

  assert.deepEqual(events.at(-1), [
    'status',
    'degraded',
    'filesystem unavailable'
  ])
})
