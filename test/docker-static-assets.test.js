const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const dockerfilePath = path.join(repoRoot, 'Dockerfile')
const staticAssetsPath = path.join(repoRoot, 'Webapp', 'staticAssets.js')

test('Webapp/staticAssets.js exists and exports mount helpers TelevisionUI requires', () => {
    assert.equal(fs.existsSync(staticAssetsPath), true)
    const source = fs.readFileSync(staticAssetsPath, 'utf8')
    assert.match(source, /function\s+mountPublicStatic\s*\(/)
    assert.match(source, /function\s+allowHlsStaticPath\s*\(/)
    assert.match(source, /module\.exports\s*=/)
    // TelevisionUI require path must resolve next to that file
    const televisionUi = fs.readFileSync(
        path.join(repoRoot, 'Webapp', 'TelevisionUI.js'),
        'utf8'
    )
    assert.match(televisionUi, /require\(['"]\.\/staticAssets\.js['"]\)/)
})

test('Dockerfile runtime stage copies staticAssets.js next to TelevisionUI.js', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8')
    assert.match(
        dockerfile,
        /COPY\s+Webapp\/TelevisionUI\.js\s+\.\/Webapp\//
    )
    assert.match(
        dockerfile,
        /COPY\s+Webapp\/staticAssets\.js\s+\.\/Webapp\//,
        'runtime image must COPY Webapp/staticAssets.js or node crashes on start with MODULE_NOT_FOUND'
    )
})
