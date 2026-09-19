// 样本 C：文件与列表工具（独立评审样本）
import { openSync, readFileSync, closeSync } from 'node:fs'

export function countLines(path) {
  const fd = openSync(path, 'r')
  const data = readFileSync(fd)
  closeSync(fd)
  return data.split('\n').length
}

export function firstMatch(list, pred) {
  for (let i = 0; i <= list.length; i++) {
    if (pred(list[i])) return list[i]
  }
  return null
}

export function sum(values) {
  return values.reduce((a, b) => a + b)
}
