const test = require('node:test')
const assert = require('node:assert/strict')

const preGeneratorPath = require.resolve('../Utilities/PreGenerator.js')
const ffMpegSessionPath = require.resolve('../Classes/FFMpegSession.js')
const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')

// Stub Log / Database so loading modules does not need native deps or a live console.
require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: () => {}
}
require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: () => ({})
}

delete require.cache[preGeneratorPath]
const { deinterlacePrefix: prePrefix } = require(preGeneratorPath)

delete require.cache[ffMpegSessionPath]
const { deinterlacePrefix: sessionPrefix } = require(ffMpegSessionPath)

for (const [name, deinterlacePrefix] of [
    ['PreGenerator.deinterlacePrefix', prePrefix],
    ['FFMpegSession.deinterlacePrefix', sessionPrefix]
]) {
    test(`${name}: yadif + cuda path uses yadif_cuda`, () => {
        assert.equal(deinterlacePrefix('yadif', true), 'yadif_cuda,')
    })

    test(`${name}: yadif_cuda + cuda path uses yadif_cuda (docker-compose default)`, () => {
        assert.equal(deinterlacePrefix('yadif_cuda', true), 'yadif_cuda,')
    })

    test(`${name}: yadif + cpu path uses yadif`, () => {
        assert.equal(deinterlacePrefix('yadif', false), 'yadif,')
    })

    test(`${name}: yadif_cuda + cpu path uses yadif`, () => {
        assert.equal(deinterlacePrefix('yadif_cuda', false), 'yadif,')
    })

    test(`${name}: other/empty filter injects nothing`, () => {
        assert.equal(deinterlacePrefix(undefined, true), '')
        assert.equal(deinterlacePrefix('', false), '')
        assert.equal(deinterlacePrefix('none', true), '')
        assert.equal(deinterlacePrefix('scale', false), '')
    })
}
