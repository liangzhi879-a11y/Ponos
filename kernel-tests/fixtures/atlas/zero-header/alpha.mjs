import { util } from './util.mjs'

export const alpha = 1
export function beta(input) { return util(input) + alpha }
const helper = 2
export { helper as gamma }
