const test = require('node:test')
const assert = require('node:assert/strict')

process.env.CHANNEL_LIST = '/unused-channels.json'

const { initializeChannels } = require('../Broadcaster.js')

test('continues initializing channels after one channel fails', () => {
  const definitions = [
    { name: 'First', slug: 'first' },
    { name: 'Unreadable', slug: 'unreadable' },
    { name: 'Last', slug: 'last' }
  ]
  const attempted = []
  const added = []
  const errors = []

  initializeChannels(definitions, {
    createChannel: definition => {
      attempted.push(definition.slug)
      if (definition.slug === 'unreadable') {
        throw new Error('EACCES: permission denied')
      }
      return definition
    },
    channelPool: {
      addChannel: channel => added.push(channel.slug)
    },
    log: (tag, message) => errors.push({ tag, message })
  })

  assert.deepEqual(attempted, ['first', 'unreadable', 'last'])
  assert.deepEqual(added, ['first', 'last'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].tag, 'Main')
  assert.match(errors[0].message, /Unable to create channel "Unreadable"/)
  assert.match(errors[0].message, /EACCES: permission denied/)
})
