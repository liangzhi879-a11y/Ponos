// kernel-tests/atlas-extract.test.mjs —— 代码卡片抽取的确定性单测
// 只测纯函数（不扫盘）：头部注释阶梯、导出/import 抽取、解析与哈希归一化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHeaderPurpose, extractExports, extractImports, extractPathRefs,
  resolveImport, hashText, normalizeText,
} from '../kernel/atlas/extract.mjs'

test('头部注释：行注释首段（跳过 shebang 与 use strict）', () => {
  const src = [
    '#!/usr/bin/env node',
    "'use strict'",
    '// Alpha 计算入口',
    '// 第二行说明',
    '',
    'export const a = 1',
  ].join('\n')
  assert.equal(extractHeaderPurpose(src, '.mjs'), 'Alpha 计算入口 第二行说明')
})

test('头部注释：块注释去装饰星号，只取第一段', () => {
  const src = [
    '/**',
    ' * 同步器：把本地变更推到远端。',
    ' * 失败时保留本地状态。',
    ' *',
    ' * 第二段不应进入职责。',
    ' */',
    'export const x = 1',
  ].join('\n')
  assert.equal(extractHeaderPurpose(src, '.mjs'), '同步器：把本地变更推到远端。 失败时保留本地状态。')
})

test('头部注释：Python 模块 docstring', () => {
  const src = '"""旧版入口。\n\n更多说明。\n"""\ndef run():\n    pass\n'
  assert.equal(extractHeaderPurpose(src, '.py'), '旧版入口。')
})

test('头部注释：TS 三斜线指令不算职责；纯 license 头返回空', () => {
  assert.equal(extractHeaderPurpose('/// <reference types="vite/client" />\n\nexport const a = 1\n', '.ts'), '')
  const license = '// Copyright 2026 Example\n// SPDX-License-Identifier: MIT\n\nexport const a = 1\n'
  assert.equal(extractHeaderPurpose(license, '.mjs'), '')
})

test('头部注释：整段许可证跳过，不把 BSD/Apache 正文当职责', () => {
  const bsd = [
    '// Copyright 2014 The Chromium Authors. All rights reserved.',
    '// Use of this source code is governed by a BSD-style license that can be',
    '// found in the LICENSE file.',
    '',
    '#include "download_item.h"',
  ].join('\n')
  assert.equal(extractHeaderPurpose(bsd, '.cc'), '', '纯许可证头不得产出职责（C++ #include 也不是注释）')

  const apache = [
    '/*',
    ' * Licensed under the Apache License, Version 2.0 (the "License");',
    ' * you may not use this file except in compliance with the License.',
    ' * You may obtain a copy of the License at',
    ' *     http://www.apache.org/licenses/LICENSE-2.0',
    ' */',
    'class Widget {};',
  ].join('\n')
  assert.equal(extractHeaderPurpose(apache, '.h'), '')
})

test('头部注释：许可证后的真实描述（空注释行/空行分隔）仍可取到', () => {
  const withBlankComment = [
    '// Copyright 2014 The Chromium Authors. All rights reserved.',
    '// Use of this source code is governed by a BSD-style license that can be',
    '// found in the LICENSE file.',
    '//',
    '// Implements the download item.',
    '',
    '#include "download_item.h"',
  ].join('\n')
  assert.equal(extractHeaderPurpose(withBlankComment, '.cc'), 'Implements the download item.')

  const withBlankLine = [
    '// Redistribution and use in source and binary forms, with or without',
    '// modification, are permitted provided that the following conditions are met:',
    '',
    '// Handles the download queue.',
    '',
    'class Widget {};',
  ].join('\n')
  assert.equal(extractHeaderPurpose(withBlankLine, '.h'), 'Handles the download queue.')

  const gpl = [
    '/*',
    ' * This file is part of Foo.',
    ' * Foo is free software: you can redistribute it and/or modify',
    ' * it under the terms of the GNU General Public License as published by',
    ' * the Free Software Foundation, either version 3 of the License, or',
    ' * (at your option) any later version.',
    ' *',
    ' * Handles the download queue.',
    ' */',
    'class Widget {};',
  ].join('\n')
  assert.equal(extractHeaderPurpose(gpl, '.cc'), 'Handles the download queue.')
})

test('头部注释：普通描述里的 license 一词不被误杀', () => {
  assert.equal(
    extractHeaderPurpose('// Handles license key validation and renewal.\nexport const a = 1\n', '.mjs'),
    'Handles license key validation and renewal.',
  )
})

test('导出：ESM / CJS / Python 的常见形态', () => {
  const esm = [
    'export const alpha = 1',
    'export function beta() {}',
    'const helper = 2',
    'export { helper as gamma }',
    'export default function Delta() {}',
  ].join('\n')
  assert.deepEqual(new Set(extractExports(esm, '.mjs')), new Set(['alpha', 'beta', 'gamma', 'Delta']))

  const cjs = 'const a = 1\nmodule.exports = { a, b: c }\nexports.d = 2\n'
  assert.deepEqual(new Set(extractExports(cjs, '.cjs')), new Set(['a', 'b', 'd']))

  const py = '"""\ndef fake():\n    pass\n"""\ndef real():\n    pass\nclass Runner:\n    pass\n'
  assert.deepEqual(new Set(extractExports(py, '.py')), new Set(['real', 'Runner']))
})

test('导出：TSX 组件名优先（大写开头）', () => {
  const src = 'export function Zed() {}\nexport const alpha = 1\nexport function Beta() {}\n'
  assert.deepEqual(extractExports(src, '.tsx'), ['Zed', 'Beta', 'alpha'])
})

test('import / require 抽取保留行号，注释里的假 import 不计入', () => {
  const src = [
    "// import fake from './x.mjs'",
    "import { a } from './a.mjs'",
    "const b = require('./b.cjs')",
  ].join('\n')
  const got = extractImports(src, '.mjs')
  assert.deepEqual(got, [
    { spec: './a.mjs', line: 2 },
    { spec: './b.cjs', line: 3 },
  ])
})

test('路径字面量抽取（非 import 的 spawn/加载路径）', () => {
  const src = "const p = './util.mjs'\nconst q = './util.mjs'\n"
  assert.deepEqual(extractPathRefs(src, '.mjs'), [{ spec: './util.mjs', line: 1 }, { spec: './util.mjs', line: 2 }])
})

test('resolveImport：相对路径、@/ 别名、.js → .ts、Python 点号模块', () => {
  const files = new Set(['src/lib/a.ts', 'src/lib/b.ts', 'src/components/ui/index.ts', 'pkg/mod.py'])
  assert.equal(resolveImport('src/lib/a.ts', './b.js', files), 'src/lib/b.ts')
  assert.equal(resolveImport('src/lib/a.ts', '@/components/ui', files), 'src/components/ui/index.ts')
  assert.equal(resolveImport('pkg/main.py', 'mod', files), 'pkg/mod.py')
  assert.equal(resolveImport('src/lib/a.ts', 'react', files), null)
  assert.equal(resolveImport('src/lib/a.ts', './missing.mjs', files), null)
})

test('哈希归一化：CRLF 与 LF 同哈希，BOM 不影响', () => {
  const a = 'export const a = 1\r\n'
  const b = '﻿export const a = 1\n'
  assert.equal(normalizeText(a), 'export const a = 1\n')
  assert.equal(hashText(a), hashText(b))
})
