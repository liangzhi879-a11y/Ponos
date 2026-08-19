# 会话集整理 + 会话级导出分享 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话历史按"会话集"组织（手动 + 一键按 cwd 自动整理），支持会话/会话集级右键导出分享，chat 数据导出按会话拆分文件、导入受控合并写回避免 localStorage 超配额。

**Architecture:** 会话集数据并入 chatStore（`conversationSets` + 会话 `setId`，随 `yfworking-chat` 一起持久化/导出）；`server/packager.mjs` 的 chats 类型导出改为拆分文件（`chats/sets.json` + `chats/sessions/<id>.json`，manifest 标记 `chat_format: 2`），导入端探测新格式聚合返回、兼容旧单文件；GUI 侧 merge 写回。agent 会话恢复走 CLI（resumeId），不受 chat 体积影响——不改动。

**Tech Stack:** React + zustand（chatStore）+ TypeScript + node:test（server 侧）+ Electron IPC（ipcMain.handle / ipcRenderer.invoke）+ System32 bsdtar（TAR_CMD）。

## Global Constraints

- `yfw-kernel/` 零修改（vendored kernel）。
- persist key `yfworking-chat` 不变；每条会话消息仍 `slice(-100)` 截断。
- 导入必须兼容旧格式包（`chats/chat-store.json` 单文件）→ 保持现状整体写回语义。
- 写前估算上限固定 4MB（超限按 updatedAt 升序裁剪最旧新会话，计入报告）。
- localStorage `setItem` 单次整串写入（不存在真分批）——"分批写回"实现为受控合并 + 截断 + 裁剪。
- 会话集删除仅解除会话归属（`setId` 置 undefined），不删除会话。
- 置顶（pinned）语义不变：全局置顶区保留在分组视图之上，pinned 会话不参与分组归属展示。
- zh-CN/en-US i18n；UI 正文中文为主（既有先例）。
- server 测试命令：`node --test "server/*.test.mjs"`（glob 形式，Windows 下目录形式报 MODULE_NOT_FOUND）。
- release 副本同步到 `release/YFWorking_ms92cd6u/`；重启 live app 前必须询问用户。

---

### Task 1: chatStore 会话集数据模型 + actions + autoOrganize + mergeImportedChats

**Files:**
- Modify: `src/types/index.ts`（`ConversationSet` 接口、`Conversation.setId`）
- Modify: `src/stores/chatStore.ts`（state + 6 个 action + partialize）

**Interfaces:**
- Consumes: 现有 `Conversation`（src/types/index.ts:77）、`generateId()`（chatStore 已有）、`persist`/`partialize`（chatStore.ts:631-642）
- Produces（Task 5/6 依赖）:
  - `interface ConversationSet { id: string; name: string; cwd?: string; createdAt: number }`
  - `Conversation.setId?: string`
  - `conversationSets: ConversationSet[]`（store state）
  - `createConversationSet(name: string, cwd?: string): string`
  - `setConversationSet(conversationId: string, setId: string | null): void`
  - `renameConversationSet(id: string, name: string): void`
  - `deleteConversationSet(id: string): void`
  - `autoOrganize(): number`（返回新建会话集数）
  - `mergeImportedChats(data: { sets: ConversationSet[]; conversations: Conversation[] }): { addedConversations: number; addedSets: number; droppedOldest: number }`

- [ ] **Step 1: types 加 ConversationSet 与 setId**

`src/types/index.ts` 的 `Conversation` 接口（77-90 行）加 `setId?: string`；在其后新增：

```ts
export interface ConversationSet {
  id: string
  name: string
  cwd?: string   // 自动整理来源目录（仅记录，不绑定）
  createdAt: number
}
```

- [ ] **Step 2: chatStore state 与 action 签名**

`src/stores/chatStore.ts`：`ChatState` 接口加：

```ts
  conversationSets: ConversationSet[]
  createConversationSet: (name: string, cwd?: string) => string
  setConversationSet: (conversationId: string, setId: string | null) => void
  renameConversationSet: (id: string, name: string) => void
  deleteConversationSet: (id: string) => void
  autoOrganize: () => number
  mergeImportedChats: (data: { sets: ConversationSet[]; conversations: Conversation[] }) => { addedConversations: number; addedSets: number; droppedOldest: number }
```

- [ ] **Step 3: 初始值与 action 实现**

初始 state（180-196 行 `conversations: []` 附近）加 `conversationSets: []`。action 实现（追加在 `reorderConversations` 之后）：

```ts
      createConversationSet: (name, cwd) => {
        const id = generateId()
        set(state => ({
          conversationSets: [...state.conversationSets, { id, name: name.trim() || '未命名会话集', cwd, createdAt: Date.now() }],
        }))
        return id
      },

      setConversationSet: (conversationId, setId) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId ? { ...c, setId: setId || undefined } : c
          ),
        }))
      },

      renameConversationSet: (id, name) => {
        set(state => ({
          conversationSets: state.conversationSets.map(s =>
            s.id === id ? { ...s, name: name.trim() || s.name } : s
          ),
        }))
      },

      deleteConversationSet: (id) => {
        set(state => ({
          conversationSets: state.conversationSets.filter(s => s.id !== id),
          conversations: state.conversations.map(c =>
            c.setId === id ? { ...c, setId: undefined } : c
          ),
        }))
      },

      autoOrganize: () => {
        const { conversations, conversationSets } = get()
        const norm = (cwd?: string) => (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
        const basename = (dir: string) => dir.split('/').filter(Boolean).pop() || dir
        const sets = [...conversationSets]
        const byName = new Map(sets.map(s => [s.name, s]))
        const updates: Record<string, Conversation> = {}
        let created = 0
        for (const c of conversations) {
          const dir = norm(c.cwd)
          if (!dir) continue
          let s = byName.get(basename(dir))
          if (!s) {
            s = { id: generateId(), name: basename(dir), cwd: dir, createdAt: Date.now() }
            sets.push(s)
            byName.set(s.name, s)
            created++
          }
          if (c.setId !== s.id) updates[c.id] = { ...c, setId: s.id }
        }
        set(state => ({
          conversationSets: sets,
          conversations: state.conversations.map(c => updates[c.id] || c),
        }))
        return created
      },

      mergeImportedChats: (data) => {
        const { conversations, conversationSets, activeConversationId, lastCwd } = get()
        const existConv = new Set(conversations.map(c => c.id))
        const existSet = new Set(conversationSets.map(s => s.id))
        const newSets = (data.sets || []).filter(s => !existSet.has(s.id))
        let newConvs = (data.conversations || []).filter(c => !existConv.has(c.id))
        newConvs = newConvs.map(c => ({ ...c, messages: (c.messages || []).slice(-100) }))
        // 写前估算：超 4MB 按 updatedAt 升序裁剪最旧新会话（localStorage 单次整串写入，无真分批）
        const LIMIT = 4 * 1024 * 1024
        const est = (convs: Conversation[]) => JSON.stringify({
          conversations: convs,
          conversationSets: [...conversationSets, ...newSets],
          activeConversationId,
          lastCwd,
        }).length
        let merged = newConvs
        let droppedOldest = 0
        let size = est(merged)
        const oldestFirst = [...newConvs].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        while (size > LIMIT && oldestFirst.length > 0) {
          const victim = oldestFirst.shift()!
          merged = merged.filter(c => c.id !== victim.id)
          droppedOldest++
          size = est(merged)
        }
        set({ conversations: [...conversations, ...merged], conversationSets: [...conversationSets, ...newSets] })
        return { addedConversations: merged.length, addedSets: newSets.length, droppedOldest }
      },
```

- [ ] **Step 4: partialize 补字段**

`partialize`（634-641 行）改为：

```ts
      partialize: (state) => ({
        conversations: state.conversations.map(c => ({
          ...c,
          messages: c.messages.slice(-100),  // Persist last 100 messages per conversation
        })),
        conversationSets: state.conversationSets,
        activeConversationId: state.activeConversationId,
        lastCwd: state.lastCwd,
      }),
```

- [ ] **Step 5: typecheck 通过**

Run: `npm run typecheck`
Expected: 0 错误

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/stores/chatStore.ts
git commit -m "feat(chat): 会话集数据模型（conversationSets + setId + autoOrganize + mergeImportedChats）"
```

---

### Task 2: packager 导出 chat 拆分（chat_format 2 + chatsFilter）

**Files:**
- Modify: `server/packager.mjs`（exportPackage chats 收集段 143-146 行；manifest 段 155-165 行）
- Test: `server/packager.test.mjs`

**Interfaces:**
- Consumes: `exportPackage(opts)` 现有签名（outPath/included/sensitiveWords/chatsJson/projectCwd/configRedact/onProgress）、`TAR_CMD`、`skipped` 报告
- Produces（Task 3/4 依赖）:
  - `exportPackage(opts.chatsFilter?: { conversationIds?: string[]; setId?: string })`
  - 新格式包内：`chats/sets.json`（`{ "sets": ConversationSet[] }`）+ `chats/sessions/<convId>.json`（完整会话对象含 setId），**不再写** `chats/chat-store.json`
  - manifest 增加 `chat_format: 2`（仅当 included 含 chats 且 chats 目录写出成功）

- [ ] **Step 1: 写失败测试**

`server/packager.test.mjs` 追加两个用例：

```js
test('chats 导出按会话拆分（sets.json + sessions/<id>.json，无旧单文件）', async () => {
  const chatsJson = JSON.stringify({
    conversationSets: [{ id: 'set1', name: '财务项目', createdAt: 1 }],
    conversations: [
      { id: 'c1', title: 'a', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' },
      { id: 'c2', title: 'b', messages: [], createdAt: 1, updatedAt: 3, model: 'x', setId: undefined },
    ],
  })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sets.json')))
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c1.json')))
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c2.json')))
  assert.ok(!fs.existsSync(path.join(staging, 'chats', 'chat-store.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.equal(manifest.chat_format, 2)
  const sets = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sets.json'), 'utf-8'))
  assert.equal(sets.sets.length, 1)
  const c1 = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sessions', 'c1.json'), 'utf-8'))
  assert.equal(c1.setId, 'set1')
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsFilter: setId 与 conversationIds 只导出所选会话', async () => {
  const chatsJson = JSON.stringify({
    conversationSets: [{ id: 'set1', name: '财务项目', createdAt: 1 }],
    conversations: [
      { id: 'c1', title: 'a', messages: [], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' },
      { id: 'c2', title: 'b', messages: [], createdAt: 1, updatedAt: 3, model: 'x', setId: undefined },
    ],
  })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, chatsFilter: { setId: 'set1' }, configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c1.json')))
  assert.ok(!fs.existsSync(path.join(staging, 'chats', 'sessions', 'c2.json')))
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsFilter.setId 不存在且无 conversationIds 时返回错误', async () => {
  const chatsJson = JSON.stringify({ conversationSets: [], conversations: [] })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, chatsFilter: { setId: 'nope' }, configRedact: true })
  assert.equal(res.ok, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/packager.test.mjs`
Expected: 新用例 FAIL（无 chat_format、仍写 chat-store.json、chatsFilter 未识别）

- [ ] **Step 3: 实现导出拆分**

`server/packager.mjs`，`exportPackage` 的 chats 段（143-146 行）替换为：

```js
    if (included.includes('chats') && chatsJson) {
      const dest = join(staging, 'chats')
      mkdirSync(dest, { recursive: true })
      let data = null
      try { data = JSON.parse(chatsJson) } catch { /* fallthrough */ }
      if (!data || !Array.isArray(data.conversations)) {
        skipped.push({ type: 'chats', reason: 'chatsJson 缺失或解析失败，跳过' })
      } else {
        const filter = opts.chatsFilter || null
        let convs = data.conversations
        if (filter) {
          const idSet = new Set(Array.isArray(filter.conversationIds) ? filter.conversationIds : [])
          if (filter.setId) {
            const set = (Array.isArray(data.conversationSets) ? data.conversationSets : []).find(s => s.id === filter.setId)
            if (!set && idSet.size === 0) return { ok: false, error: `chatsFilter.setId 不存在: ${filter.setId}` }
            if (set) for (const c of data.conversations) if (c.setId === filter.setId) idSet.add(c.id)
          }
          convs = data.conversations.filter(c => idSet.has(c.id))
        }
        // 每会话一个文件（完整对象含 setId）；会话集清单单独文件
        const sets = Array.isArray(data.conversationSets) ? data.conversationSets : []
        writeFileSync(join(dest, 'sets.json'), JSON.stringify({ sets }, null, 2), 'utf-8')
        mkdirSync(join(dest, 'sessions'), { recursive: true })
        for (const c of convs) {
          writeFileSync(join(dest, 'sessions', `${c.id}.json`), JSON.stringify(c, null, 2), 'utf-8')
        }
      }
    }
```

manifest 段（155-165 行）在 `writeFileSync(join(staging, 'manifest.json') ...)` 前追加：

```js
    if (included.includes('chats')) manifest.chat_format = 2
```

（chats 解析失败被跳过时仍标记 chat_format 2，但导入端以"存在 chats/sessions/"为准探测，安全。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/packager.test.mjs`
Expected: 全部 PASS（原 15 + 新 3 = 18）

- [ ] **Step 5: Commit**

```bash
git add server/packager.mjs server/packager.test.mjs
git commit -m "feat(chat): chats 导出按会话拆分（sets.json + sessions/<id>.json）+ chatsFilter 过滤"
```

---

### Task 3: packager 导入聚合（新格式）+ 旧格式兼容

**Files:**
- Modify: `server/packager.mjs`（importPackage chats 段 292-297 行；返回结构）
- Test: `server/packager.test.mjs`

**Interfaces:**
- Consumes: Task 2 的导出格式（`chats/sets.json` + `chats/sessions/<id>.json`）
- Produces（Task 4/6 依赖）:
  - `importPackage` 返回增加 `chats?: { sets: ConversationSet[]; conversations: Conversation[] }`（新格式聚合；不写盘，renderer 侧合并）
  - 旧格式（仅 `chats/chat-store.json`）保持返回 `chatStoreJson?: string`

- [ ] **Step 1: 写失败测试**

```js
test('导入新格式 chats：聚合 sets + conversations（不写盘）', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-new.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'], chat_format: 2 }),
    'chats/sets.json': JSON.stringify({ sets: [{ id: 'set1', name: '财务项目', createdAt: 1 }] }),
    'chats/sessions/c1.json': JSON.stringify({ id: 'c1', title: 'a', messages: [], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.chats)
  assert.equal(res.chats.sets.length, 1)
  assert.equal(res.chats.conversations.length, 1)
  assert.equal(res.chats.conversations[0].setId, 'set1')
  assert.equal(res.chatStoreJson, null)
})

test('导入新格式 chats：损坏会话文件 conflicts++ 且整体 ok', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-bad.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'], chat_format: 2 }),
    'chats/sets.json': JSON.stringify({ sets: [] }),
    'chats/sessions/good.json': JSON.stringify({ id: 'g', title: 'ok', messages: [], createdAt: 1, updatedAt: 2, model: 'x' }),
    'chats/sessions/bad.json': '{ not json !!!',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.conflicts >= 1)
  assert.equal(res.chats.conversations.length, 1)
})

test('导入旧格式 chats：仍返回 chatStoreJson 整体写回', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-old.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'] }),
    'chats/chat-store.json': JSON.stringify({ conversations: [{ id: 'old1', title: 'x', messages: [], createdAt: 1, updatedAt: 2, model: 'x' }], activeConversationId: null, lastCwd: '' }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.chatStoreJson)
  assert.equal(res.chats, null)
  assert.ok(res.chatStoreJson.includes('old1'))
})
```

（"不写盘"由 importPackage 代码结构保证——chats 只在 staging 处理、以对象返回，renderer 侧合并；用例以 `res.chats` 非空 + `chatStoreJson` 为 null 验证新格式路径。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/packager.test.mjs`
Expected: 新用例 FAIL（返回无 chats 字段）

- [ ] **Step 3: 实现导入聚合**

`server/packager.mjs`，importPackage 的 chats 段（292-297 行）替换为：

```js
    let chatStoreJson = null
    let chats = null
    if (included.includes('chats')) {
      const sessionsDir = join(staging, 'chats', 'sessions')
      const legacyFile = join(staging, 'chats', 'chat-store.json')
      if (existsSync(sessionsDir)) {
        // 新格式：聚合 sets + conversations（每会话一文件），renderer 侧合并写回
        const setsJsonPath = join(staging, 'chats', 'sets.json')
        let sets = []
        if (existsSync(setsJsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(setsJsonPath, 'utf-8'))
            if (Array.isArray(parsed.sets)) sets = parsed.sets
          } catch { /* 损坏按空处理 */ }
        }
        const conversations = []
        for (const f of readdirSync(sessionsDir)) {
          const src = join(sessionsDir, f)
          if (!statSync(src).isFile() || !f.endsWith('.json')) continue
          try {
            conversations.push(JSON.parse(readFileSync(src, 'utf-8')))
          } catch {
            conflicts++
            restored.push(`chats/sessions/${f} (损坏，跳过)`)
          }
        }
        chats = { sets, conversations }
        restored.push(`chats/sessions (${conversations.length} 个会话)`)
      } else if (existsSync(legacyFile)) {
        // 旧格式：整体回传 renderer 写回（兼容旧包）
        chatStoreJson = readFileSync(legacyFile, 'utf-8')
        restored.push('chats/chat-store.json (旧格式，整体写回)')
      }
    }
```

返回结构（299 行）改为 `return { ok: true, manifest, restored, conflicts, chats, chatStoreJson }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/packager.test.mjs`
Expected: 全部 PASS（18 + 3 = 21）

- [ ] **Step 5: Commit**

```bash
git add server/packager.mjs server/packager.test.mjs
git commit -m "feat(chat): chats 导入聚合新格式（sets + conversations）+ 旧单文件兼容"
```

---

### Task 4: Electron IPC 透传 chatsFilter + preload + 类型

**Files:**
- Modify: `electron/main.cjs`（experience:export handler 714-721 行）
- Modify: `electron/preload.cjs`（exportExperience 方法）
- Modify: `src/types/index.ts`（YFWAPI.exportExperience / importExperience 类型）

**Interfaces:**
- Consumes: Task 2 的 `exportPackage(opts.chatsFilter)`、Task 3 的返回结构
- Produces（Task 5/6 依赖）:
  - `window.yfworkingAPI.exportExperience(opts)` 支持 `opts.chatsFilter: { conversationIds?: string[]; setId?: string } | null`
  - `window.yfworkingAPI.importExperience(opts)` 返回类型含 `chats?: { sets: unknown[]; conversations: unknown[] } | null`

- [ ] **Step 1: main.cjs 透传**

`electron/main.cjs` experience:export handler 的 `exportPackage({...})` 调用加一行参数：

```js
        chatsFilter: payload?.chatsFilter && typeof payload.chatsFilter === 'object' ? payload.chatsFilter : null,
```

- [ ] **Step 2: preload 透传**

`electron/preload.cjs` 的 `exportExperience`（现 `(opts) => ipcRenderer.invoke('experience:export', opts)`）无需改代码（opts 整体透传），仅确认存在。若未来需要显式白名单，改为：

```js
  exportExperience: (opts) => ipcRenderer.invoke('experience:export', opts),
```

（现状已是透传，无需改动；Step 2 仅验证。）

- [ ] **Step 3: YFWAPI 类型更新**

`src/types/index.ts` 的 `YFWAPI` 接口：

```ts
  exportExperience: (opts: { included: string[]; sensitiveWords?: string[]; chatsJson?: string | null; projectCwd?: string | null; configRedact?: boolean; chatsFilter?: { conversationIds?: string[]; setId?: string } | null }) => Promise<{ ok: boolean; outPath?: string; skipped?: { type: string; reason: string }[]; error?: string; canceled?: boolean }>
  importExperience: (opts: { conflict: 'skip' | 'overwrite' | 'merge'; projectCwd?: string | null }) => Promise<{ ok: boolean; restored?: string[]; chatStoreJson?: string | null; chats?: { sets: { id: string; name: string; cwd?: string; createdAt: number }[]; conversations: { id: string; title: string; messages: unknown[]; setId?: string }[] } | null; conflicts?: number; error?: string; canceled?: boolean }>
```

- [ ] **Step 4: 验证**

Run: `node --check electron/main.cjs && node --check electron/preload.cjs && npm run typecheck`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add electron/main.cjs electron/preload.cjs src/types/index.ts
git commit -m "feat(chat): IPC 透传 chatsFilter + YFWAPI export/import 类型（chats 聚合 + canceled）"
```

---

### Task 5: Sidebar 会话集分组 UI + 右键导出/移动 + 自动整理

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: Task 1 的 `conversationSets` / `setId` / `createConversationSet` / `setConversationSet` / `renameConversationSet` / `deleteConversationSet` / `autoOrganize`；Task 4 的 `exportExperience(opts.chatsFilter)`
- Produces: 无（终端 UI）

- [ ] **Step 1: i18n key**

zh-CN `sidebar` 命名空间追加：

```ts
    organize: '一键整理',
    ungrouped: '未分组',
    moveToSet: '移动到会话集',
    exportShare: '导出分享',
    newSet: '新建会话集',
    exportSet: '导出会话集',
```

en-US 对应：

```ts
    organize: 'Auto-organize',
    ungrouped: 'Ungrouped',
    moveToSet: 'Move to set',
    exportShare: 'Export & share',
    newSet: 'New set',
    exportSet: 'Export set',
```

- [ ] **Step 2: Sidebar 分组渲染**

`Sidebar.tsx`：
- `useChatStore` 追加订阅：`conversationSets`、`createConversationSet`、`setConversationSet`、`renameConversationSet`、`deleteConversationSet`、`autoOrganize`。
- 本地 state：`const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})`、`const [setMenuId, setSetMenuId] = useState<string | null>(null)`、`const [renamingSetId, setRenamingSetId] = useState<string | null>(null)`、`const [renamingSetValue, setRenamingSetValue] = useState('')`、`const [moveTarget, setMoveTarget] = useState<string | null>(null)`（会话右键"移动到会话集"子菜单目标会话 id）、`const [setMenuPos, setSetMenuPos] = useState<{left:number;top:number}|null>(null)`。
- 搜索行（159-198 行）加"一键整理"按钮（`Wand2` 图标，lucide-react 追加 import），onClick 调 `autoOrganize()` 后 `setMsg`/无提示即可：

```tsx
              <Tooltip content={t('sidebar.organize')}>
                <Button variant="ghost" size="xs" aria-label={t('sidebar.organize')} onClick={() => autoOrganize()}>
                  <Wand2 className="w-3.5 h-3.5" />
                </Button>
              </Tooltip>
```

- 会话列表（201-215 行起）：pinned 区保留；非 pinned 改为分组渲染：

```tsx
                {pinned.length > 0 && (
                  <div className="mb-1">
                    <div className="px-2 py-1 text-[10px] font-semibold text-tertiary uppercase tracking-wider">{t('sidebar.pinned')}</div>
                    {pinned.map(renderItem)}
                  </div>
                )}
                {filteredSets.map(s => {
                  const members = unpinned.filter(c => c.setId === s.id)
                  if (members.length === 0) return null
                  const open = !collapsed[s.id]
                  return (
                    <div key={s.id} className="mb-1">
                      <div
                        className="flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer hover:bg-elevated group"
                        onClick={() => setCollapsed(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                        onContextMenu={(e) => { e.preventDefault(); openSetMenu(e, s.id) }}
                      >
                        <ChevronRight className={cn('w-3 h-3 text-tertiary transition-transform', open && 'rotate-90')} />
                        <FolderOpen className="w-3 h-3 text-brand-500/70 shrink-0" />
                        <span className="flex-1 min-w-0 truncate text-xs text-secondary">{s.name}</span>
                        <span className="text-[10px] text-tertiary tabular-nums">{members.length}</span>
                      </div>
                      {open && <div className="ml-2 border-l border-input/60 pl-1">{members.map(renderItem)}</div>}
                    </div>
                  )
                })}
                {unpinned.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-[10px] font-semibold text-tertiary uppercase tracking-wider">{t('sidebar.ungrouped')}</div>
                    {unpinned.filter(c => !c.setId).map(renderItem)}
                  </div>
                )}
```

其中 `filteredSets` = 按名称排序的 `conversationSets`。`unpinned` = 现有 `filtered.filter(c => !c.pinned)`（保持不变）。注意：现有 `unpinned.map(renderItem)` 的直接列表区（209 行 `<div>` 内）被上面的分组视图替换。

- [ ] **Step 3: 会话集右键菜单 + 重命名 + 会话右键新项**

- `openSetMenu(e, setId)`：仿照会话右键的 viewport 定位逻辑（275-292 行）计算 `setMenuPos`，`setSetMenuId(setId)`。
- 会话集右键菜单（portal 到 body，样式与现有一致）项：
  - 重命名（复用 inline 编辑模式：`renamingSetId` + 在会话集头渲染 input）
  - 导出会话集：`onExportSet(s.id)`
  - 删除：`deleteConversationSet(s.id)`（确认后）
- 会话右键菜单（379-383 行）在"置顶"后新增两项 + 分隔线：

```tsx
          <button onClick={() => setMoveTarget(conv.id)} aria-label={t('sidebar.moveToSet')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><FolderPlus className="w-3 h-3" /> {t('sidebar.moveToSet')}</button>
          <button onClick={() => onExportConversation(conv.id)} aria-label={t('sidebar.exportShare')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Share2 className="w-3 h-3" /> {t('sidebar.exportShare')}</button>
          <div className="border-t my-1" />
```

（`FolderPlus`、`Share2` 追加 lucide import；菜单高度常量 MENU_H 172 → 改 220。）

- 移动子菜单（`moveTarget` 非空时渲染在会话右键菜单同级或独立 portal）：

```tsx
      {moveTarget && (
        <div className="fixed z-[100] w-44 border border glass-context-menu rounded-lg py-1 animate-scale-in" style={{ left: menuPos?.left, top: (menuPos?.top || 0) + 40, backgroundColor: 'var(--popover-bg)', backdropFilter: 'blur(var(--popover-blur))', WebkitBackdropFilter: 'blur(var(--popover-blur))' }}>
          {conversationSets.map(s => (
            <button key={s.id} onClick={() => { setConversationSet(moveTarget, s.id); setMoveTarget(null); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><FolderOpen className="w-3 h-3" /> {s.name}</button>
          ))}
          <button onClick={() => { setConversationSet(moveTarget, null); setMoveTarget(null); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><span className="w-3 h-3" /> {t('sidebar.ungrouped')}</button>
          <div className="border-t my-1" />
          <button onClick={() => { const id = createConversationSet('新会话集'); setConversationSet(moveTarget, id); setMoveTarget(null); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Plus className="w-3 h-3" /> {t('sidebar.newSet')}</button>
        </div>
      )}
```

- [ ] **Step 4: 导出分享/导出会话集处理**

```tsx
  const exportChats = (chatsFilter: { conversationIds?: string[]; setId?: string }) => {
    let chatsJson: string | null = null
    try { chatsJson = window.localStorage.getItem('yfworking-chat') } catch {}
    window.yfworkingAPI.exportExperience({
      included: ['chats'],
      chatsJson,
      chatsFilter,
      configRedact: true,
    }).then(res => {
      if (!res.ok) { /* 静默或 console.warn：取消时不打扰 */ console.warn('导出取消或失败', res.error) }
    })
  }
```

- `onExportConversation(id)` → `exportChats({ conversationIds: [id] })`
- `onExportSet(setId)` → `exportChats({ setId })`
- 注意 dev 模式（无 preload）：`window.yfworkingAPI` 可能缺失 → 守卫 `if (!window.yfworkingAPI) return`（沿用 ExperiencePanel 的守卫惯例）。

- [ ] **Step 5: typecheck + 运行确认**

Run: `npm run typecheck`
Expected: 0 错误

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/Sidebar.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(chat): 侧边栏会话集分组（折叠/右键重命名/导出/删除）+ 会话右键移动与导出分享 + 一键整理"
```

---

### Task 6: ExperiencePanel 导入合并写回 + 导出对话框 chats 范围

**Files:**
- Modify: `src/components/settings/ExperiencePanel.tsx`

**Interfaces:**
- Consumes: Task 1 的 `mergeImportedChats`、Task 3 的 `importExperience` 返回 `chats`、Task 4 的 `exportExperience(opts.chatsFilter)`；`useChatStore` 的 `conversations` / `conversationSets`
- Produces: 无（终端 UI）

- [ ] **Step 1: 导入回调合并写回**

`ExperiencePanel.tsx` ImportDialog 的 `run()`（现状 274-281 行，`if (res.chatStoreJson) localStorage.setItem(...)`）改为：

```tsx
  const run = async () => {
    const res = await window.yfworkingAPI.importExperience({ conflict, projectCwd: lastCwd })
    if (!res.ok) { onDone(res.error || '导入失败（可能已取消）'); onClose(); return }
    let note = ''
    if (res.chats) {
      // 新格式：逐会话合并写回（按 id 去重 + 100 条截断 + 4MB 估算裁剪）
      const r = useChatStore.getState().mergeImportedChats(res.chats)
      note = `新增会话 ${r.addedConversations}${r.droppedOldest ? `，因体积裁剪最旧 ${r.droppedOldest} 个` : ''}`
    } else if (res.chatStoreJson) {
      try { window.localStorage.setItem('yfworking-chat', res.chatStoreJson) } catch (e) { note = '，写回 localStorage 失败（体积过大或配额不足），本地会话未变' }
    }
    onDone(`导入完成：恢复 ${res.restored?.length ?? 0} 项${res.conflicts ? `，跳过冲突 ${res.conflicts} 项` : ''}${note}`)
    onClose()
  }
```

（顶部补 `import { useChatStore } from '@/stores/chatStore'`。）

- [ ] **Step 2: 导出对话框 chats 范围**

`ExperiencePanel.tsx` ExportDialog：`useChatStore` 读 `conversations`、`conversationSets`；勾选 chats 时显示范围行：

```tsx
        {sel.chats && (
          <div className="mb-4 space-y-1">
            <label className="block text-[10px] text-tertiary mb-1">chats 范围</label>
            <select
              value={chatsScope}
              onChange={e => setChatsScope(e.target.value)}
              className="w-full h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="all">全部会话</option>
              {conversationSets.map(s => <option key={s.id} value={`set:${s.id}`}>会话集：{s.name}</option>)}
            </select>
          </div>
        )}
```

- `chatsScope` state 默认 `'all'`；`run()` 里根据 scope 构造 `chatsFilter`：

```tsx
    let chatsFilter: { conversationIds?: string[]; setId?: string } | null = null
    if (sel.chats && chatsScope.startsWith('set:')) chatsFilter = { setId: chatsScope.slice(4) }
    const res = await window.yfworkingAPI.exportExperience({
      included,
      sensitiveWords: words.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      chatsJson: sel.chats ? chatsJson() : null,
      projectCwd: sel.project ? (lastCwd || null) : null,
      configRedact: true,
      chatsFilter,
    })
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/ExperiencePanel.tsx
git commit -m "feat(chat): 导入按会话合并写回（去重/截断/裁剪）+ 导出对话框 chats 范围选择"
```

---

### Task 7: 全量验证 + release 同步

**Files:**
- Modify: 无源码（仅验证与同步）

- [ ] **Step 1: 全量静态检查 + 单元测试**

```bash
node --check server/packager.mjs && node --check server/experience.mjs && node --check server/bridge.mjs
node --check electron/main.cjs && node --check electron/preload.cjs
npm run typecheck
node --test "server/*.test.mjs"
node scripts/verify-experience-inject.mjs
```

Expected: 全部通过（typecheck 0 错误；测试全 PASS；verify exit 0）

- [ ] **Step 2: 同步 release 副本**

```bash
cp server/packager.mjs server/experience.mjs server/bridge.mjs release/YFWorking_ms92cd6u/server/
cp electron/main.cjs electron/preload.cjs release/YFWorking_ms92cd6u/electron/
npm run build
cp -r dist/. release/YFWorking_ms92cd6u/dist/
```

- [ ] **Step 3: 汇报**

- 功能清单、验证结果、release 同步情况。
- **询问用户**是否重启 live app 验证（不得擅自杀进程/重启）。

---

## Self-Review 记录

- **Spec coverage**：§3 数据模型 → Task 1；§4 自动整理 → Task 1（autoOrganize）+ Task 5（按钮）；§5 UI 分组/右键/折叠 → Task 5；§6 导出拆分 + chatsFilter + chat_format 2 → Task 2 + Task 4 + Task 5/6 入口；§7 导入聚合 + 兼容 + 4MB 裁剪 → Task 3 + Task 6；§8 错误处理/测试 → Task 2/3 用例 + Task 7；§9 文件清单 → 全部覆盖。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整代码。
- **Type consistency**：`ConversationSet`（Task 1 定义，Task 2/3/5/6 引用）；`setId`（Task 1 → Task 2/3/5）；`chatsFilter`（Task 2 exportPackage → Task 4 IPC/preload → Task 5/6 调用）；`mergeImportedChats` 返回 `{addedConversations, addedSets, droppedOldest}`（Task 1 → Task 6）；`importPackage` 返回 `{chats?, chatStoreJson?}`（Task 3 → Task 4 类型 → Task 6）。全链路一致。
