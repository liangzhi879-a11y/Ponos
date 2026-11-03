import { beta } from './alpha.mjs'
const UTIL_PATH = './util.mjs'
export function run(v) { return beta(v) + UTIL_PATH.length }
