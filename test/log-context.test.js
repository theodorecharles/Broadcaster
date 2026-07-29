const test = require('node:test')
const assert = require('node:assert/strict')

const {
    INSTANCE_ID,
    MAX_VALUE_LENGTH,
    MAX_FIELDS,
    isError,
    newCorrelationId,
    normalizeContext,
    formatContextForConsole
} = require('../Utilities/LogContext.js')

test('an Error passed directly becomes message + stack fields', () => {
    const error = new TypeError('device unreachable')
    const { fields, stack, hasError } = normalizeContext(error)

    assert.equal(hasError, true)
    assert.equal(fields.error, 'TypeError: device unreachable')
    assert.match(fields.error_stack, /device unreachable/)
    assert.match(fields.error_stack, /at /)
    assert.equal(fields.error_stack, stack)
})

test('an error inside a context object keeps the sibling fields', () => {
    const error = new Error('boom')
    error.code = 'ENOENT'
    const { fields } = normalizeContext({ error, device_id: 'live-3576-a1', attempt: 2, gpu: false })

    assert.equal(fields.error, 'Error: boom')
    assert.equal(fields.error_code, 'ENOENT')
    assert.match(fields.error_stack, /at /)
    assert.equal(fields.device_id, 'live-3576-a1')
    assert.equal(fields.attempt, 2)
    assert.equal(fields.gpu, false)
})

test('cause chains are kept in the stack', () => {
    const root = new Error('socket closed')
    const wrapper = new Error('unable to reach device', { cause: root })
    const { fields } = normalizeContext({ err: wrapper })

    assert.match(fields.error_stack, /unable to reach device/)
    assert.match(fields.error_stack, /caused by:/)
    assert.match(fields.error_stack, /socket closed/)
})

test('correlation aliases collapse onto correlation_id', () => {
    for (const key of ['correlation_id', 'correlationId', 'request_id', 'requestId', 'trace_id', 'traceId']) {
        const { fields } = normalizeContext({ [key]: 'req-abc123' })
        assert.equal(fields.correlation_id, 'req-abc123', `alias ${key}`)
        assert.equal(Object.keys(fields).length, 1, `alias ${key} left extra keys`)
    }
})

test('reserved envelope keys are dropped and undefined values skipped', () => {
    const { fields } = normalizeContext({ ts: 'nope', level: 'fatal', msg: 'nope', instance: 'nope', keep: 'yes', gone: undefined })

    assert.deepEqual(fields, { keep: 'yes' })
})

test('values are flattened, truncated, and field count is capped', () => {
    const long = 'x'.repeat(MAX_VALUE_LENGTH + 200)
    const wide = {}
    for (let i = 0; i < MAX_FIELDS + 10; i += 1) wide[`field_${i}`] = i

    const flat = normalizeContext({ long, nested: { a: [1, 2] }, when: new Date('2026-07-29T21:43:44.000Z') }).fields
    assert.ok(flat.long.length < long.length)
    assert.match(flat.long, /\[\+200 chars\]$/)
    assert.equal(flat.nested, '{"a":[1,2]}')
    assert.equal(flat.when, '2026-07-29T21:43:44.000Z')

    const capped = normalizeContext(wide).fields
    assert.equal(capped.context_truncated, true)
    assert.ok(Object.keys(capped).length <= MAX_FIELDS + 1)
})

test('circular structures do not throw', () => {
    const circular = { name: 'loop' }
    circular.self = circular

    const { fields } = normalizeContext({ circular })
    assert.equal(typeof fields.circular, 'string')
})

test('non-object context is preserved under a context field', () => {
    assert.deepEqual(normalizeContext('just a string').fields, { context: 'just a string' })
    assert.deepEqual(normalizeContext(undefined).fields, {})
    assert.deepEqual(normalizeContext(null).fields, {})
})

test('console formatting appends key=value pairs and the stack', () => {
    const normalized = normalizeContext({ error: new Error('boom'), device_id: 'live-3576-a1' })
    const rendered = formatContextForConsole(normalized)

    assert.match(rendered, /device_id="live-3576-a1"/)
    assert.match(rendered, /error="Error: boom"/)
    assert.ok(!rendered.split('\n')[0].includes('error_stack'))
    assert.match(rendered, /\n.*at /s)
    assert.equal(formatContextForConsole(normalizeContext(undefined)), '')
})

test('identifiers are process-stable and per-call unique', () => {
    assert.match(INSTANCE_ID, new RegExp(`^${process.pid}-[0-9a-f]{6}$`))
    assert.notEqual(newCorrelationId(), newCorrelationId())
    assert.match(newCorrelationId('job'), /^job-[0-9a-f]{12}$/)
})

test('isError accepts cross-realm error shapes', () => {
    assert.equal(isError(new Error('x')), true)
    assert.equal(isError({ message: 'x', stack: 'Error: x\n    at fake' }), true)
    assert.equal(isError({ name: 'Example Channel' }), false)
    assert.equal(isError(null), false)
})
