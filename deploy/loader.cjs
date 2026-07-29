'use strict'

const { app } = require('electron')
const Module = require('module')
const path = require('path')

// Electron resolves resources/app.asar before resources/app. The injection is
// the tiny app.asar; Tencent's untouched application stays in resources/app.
const officialApp = path.join(process.resourcesPath, 'app')
app.setAppPath(officialApp)
for (const key of Object.keys(Module._cache)) {
  if (key.includes(`${path.sep}app.asar${path.sep}`)) delete Module._cache[key]
}

require('./main.cjs')
Module._load(path.join(officialApp, 'application.asar', 'app_launcher', 'index.js'), module, true)
