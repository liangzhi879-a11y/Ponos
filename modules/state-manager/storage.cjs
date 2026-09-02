'use strict'

const fs = require('node:fs')

/** JSON 文件持久化（零原生依赖）。load 容错：文件缺失/损坏返回 null。 */
function createFileStorage(path) {
  return {
    load() {
      try {
        const raw = fs.readFileSync(path, 'utf8')
        return JSON.parse(raw)
      } catch { return null }
    },
    save(data) {
      fs.mkdirSync(require('node:path').dirname(path), { recursive: true })
      fs.writeFileSync(path, JSON.stringify(data, null, 2))
    },
  }
}

module.exports = { createFileStorage }
