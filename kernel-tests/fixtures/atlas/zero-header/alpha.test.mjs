import test from 'node:test'
import assert from 'node:assert/strict'
import { beta } from './alpha.mjs'

test('beta adds one to the doubled input', () => {
  assert.equal(beta(1), 3)
})
