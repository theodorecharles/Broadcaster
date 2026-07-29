const crypto = require('crypto')

// Structured context for log lines. Log() takes an optional context object; everything here turns
// that object into flat, bounded, JSON-safe fields so an ERROR line is triageable from the log alone
// (error message + stack + the key inputs + a correlation id) without a redeploy to add detail.

const MAX_VALUE_LENGTH = 512
const MAX_STACK_LENGTH = 4096
const MAX_FIELDS = 24

// One id per process start. Stamped on every shipped record so lines from the same container run can
// be pulled together even when their call sites are unrelated.
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`

// Fields the shipper owns; context must never clobber them.
const RESERVED_FIELDS = new Set(['ts', 'level', 'msg', 'source', 'channel', 'queuedAt', 'instance'])

// All of these mean "tie this line to the other lines from the same unit of work".
const CORRELATION_KEYS = ['correlation_id', 'correlationId', 'request_id', 'requestId', 'trace_id', 'traceId']

const ERROR_KEYS = ['error', 'err', 'exception', 'cause']

function isError(value) {
    if (value instanceof Error) return true
    return Boolean(value) && typeof value === 'object' &&
        typeof value.message === 'string' && typeof value.stack === 'string'
}

function newCorrelationId(prefix = 'req') {
    return `${prefix}-${crypto.randomBytes(6).toString('hex')}`
}

function truncate(text, limit) {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)}…[+${text.length - limit} chars]`
}

// Log records travel as JSON, so anything that is not a scalar gets stringified rather than dropped.
function flattenValue(value) {
    if (value === null) return null
    if (typeof value === 'string') return truncate(value, MAX_VALUE_LENGTH)
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
    if (value instanceof Date) return value.toISOString()
    if (isError(value)) return truncate(describeError(value), MAX_VALUE_LENGTH)
    try {
        return truncate(JSON.stringify(value), MAX_VALUE_LENGTH)
    } catch (e) {
        return truncate(String(value), MAX_VALUE_LENGTH)
    }
}

function describeError(error) {
    const name = error.name || 'Error'
    const message = typeof error.message === 'string' ? error.message : String(error.message ?? '')
    return message ? `${name}: ${message}` : name
}

// Keeps `caused by` chains: without them the stack often stops at a wrapper.
function describeStack(error) {
    const parts = []
    let current = error
    let depth = 0
    while (isError(current) && depth < 3) {
        parts.push(typeof current.stack === 'string' && current.stack !== '' ? current.stack : describeError(current))
        current = current.cause
        depth += 1
        if (isError(current)) parts.push('caused by:')
    }
    return truncate(parts.join('\n'), MAX_STACK_LENGTH)
}

function sanitizeKey(key) {
    return String(key).trim().replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * Normalizes a caller-supplied context into flat log fields.
 *
 * Accepts an Error directly, or an object of key/value pairs which may itself carry an Error under
 * `error` / `err` / `exception` / `cause`. Correlation aliases collapse to `correlation_id`.
 *
 * @returns {{fields: object, stack: string|null, hasError: boolean}}
 */
function normalizeContext(context) {
    const empty = { fields: {}, stack: null, hasError: false }
    if (context === undefined || context === null) return empty

    const source = isError(context) ? { error: context } : context
    if (typeof source !== 'object' || Array.isArray(source)) {
        return { fields: { context: flattenValue(source) }, stack: null, hasError: false }
    }

    const fields = {}
    let stack = null
    let hasError = false

    for (const [rawKey, value] of Object.entries(source)) {
        if (value === undefined) continue

        const key = sanitizeKey(rawKey)
        if (key === '' || RESERVED_FIELDS.has(key)) continue

        if (CORRELATION_KEYS.includes(rawKey) || CORRELATION_KEYS.includes(key)) {
            const correlation = flattenValue(value)
            if (correlation !== null && correlation !== '') fields.correlation_id = correlation
            continue
        }

        if (ERROR_KEYS.includes(rawKey) && isError(value)) {
            // First error wins the canonical fields; later ones keep their own key.
            if (!hasError) {
                hasError = true
                fields.error = truncate(describeError(value), MAX_VALUE_LENGTH)
                stack = describeStack(value)
                if (stack) fields.error_stack = stack
                if (value.code !== undefined) fields.error_code = flattenValue(value.code)
                continue
            }
        }

        if (Object.keys(fields).length >= MAX_FIELDS) {
            fields.context_truncated = true
            break
        }

        fields[key] = flattenValue(value)
    }

    return { fields, stack, hasError }
}

// Verbose console output should carry the same detail the shipped record does.
function formatContextForConsole(normalized) {
    if (!normalized || !normalized.fields) return ''
    const pairs = Object.entries(normalized.fields)
        .filter(([key]) => key !== 'error_stack')
        .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`)

    const suffix = pairs.length > 0 ? ` | ${pairs.join(' ')}` : ''
    return normalized.stack ? `${suffix}\n${normalized.stack}` : suffix
}

module.exports = {
    INSTANCE_ID,
    RESERVED_FIELDS,
    CORRELATION_KEYS,
    MAX_VALUE_LENGTH,
    MAX_STACK_LENGTH,
    MAX_FIELDS,
    isError,
    newCorrelationId,
    normalizeContext,
    formatContextForConsole
}
