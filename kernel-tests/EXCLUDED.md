# 内核仓不收录的测试清单（宿主面测试）

本仓是**内核线**：只带 `kernel/` + `shared/` + `workflows/` + 内核脚本，不带宿主（Electron 主进程、渲染层、
HTTP bridge、打包面）。应用仓的 `kernel-tests/`（311 个）里有一批测试实际测的是**宿主面** ——
它们要么 `import` 宿主目录，要么在运行时读宿主产物（`server/bridge.mjs`、`electron/main.cjs`、
`src/…`、`docs/…`、`dist/…`），要么断言内核与宿主的 parity。这类测试在本仓必然失败（不是内核坏了）。

判据（与本仓 README §6.1 同一条）：**能不能在没有界面的 Node 进程里、只依赖 `kernel/` + `shared/` 跑完**。
不能 ⇒ 不进本仓；这些断言由应用仓的 CI 覆盖，不要在本仓"改断言让它变绿"。

同步口径（2026-11-03）：从应用仓 `kernel-tests/` 复制了 311 个测试文件（+ helper/fixture），
本清单共 **98 个**未收录。核对方式：`node --test "kernel-tests/*.test.mjs" "shared/*.test.mjs"` ⇒
3068 例 / 3057 通过 / 11 跳过 / **0 失败**。

## A 组：静态 import 宿主目录（60 个）

`import`/`require` 了 `../electron/…`、`../src/…`、`../server/…` —— 内核仓没有这些目录，加载即失败。

```
ai03-egress-policy.test.mjs
app-agent-http-file-doctrine.test.mjs
app-agent-requirement.test.mjs
app-agent-review-loop.test.mjs
app-agent-review.test.mjs
app-agent.test.mjs
app-bind-lifecycle.test.mjs
app-bindings.test.mjs
app-capability.test.mjs
app-e2e.test.mjs
app-egress-gate.test.mjs
app-exec-wiring.test.mjs
app-explore-tools.test.mjs
app-generate-http-file-contract.test.mjs
app-generate-ipc.test.mjs
app-generate.test.mjs
app-http-probe.test.mjs
app-ipc-integration.test.mjs
app-llm.test.mjs
app-login-state.test.mjs
app-login-wall.test.mjs
app-login.test.mjs
app-probe-surface.test.mjs
app-profiler-desktop.test.mjs
app-profiler-web.test.mjs
app-profiler.test.mjs
app-quality-ipc.test.mjs
app-registry-backup.test.mjs
app-registry-path-safety.test.mjs
app-registry.test.mjs
app-repair.test.mjs
app-runner-desktop.test.mjs
app-runner-file.test.mjs
app-runner-http.test.mjs
app-runner-route.test.mjs
app-runner.test.mjs
app-script-langs.test.mjs
app-session-key.test.mjs
app-snapshot-shape.test.mjs
app-websearch.test.mjs
attribution-d4d5.test.mjs
browser-executor-cookies.test.mjs
browser-executor-login-window.test.mjs
card01-askuser-tolerance.test.mjs
eng05-asr-stream.test.mjs
evo06-tag-render-surface.test.mjs
knowledge-import-vision.test.mjs
knowledge-import.test.mjs
log01-gaps.test.mjs
loop-e2e-resurrect.test.mjs
loop-panel-roundtrip.test.mjs
screen-contract.test.mjs
screen-coord-parity.test.mjs
screen-input-authorization.test.mjs
sec06-auth-audit.test.mjs
sediment-guidance.test.mjs
sess05-cwd-key.test.mjs
skill-forge-e2e.test.mjs
tag-registry-parity.test.mjs
ui23-workflow-version-ts.test.mjs
```

## B 组：运行时读取宿主产物（22 个）

能加载，但断言里读取 `server/`、`electron/`、`src/`、`dist/`、`electron-builder.yml` 等宿主文件（含 ENOENT 兜底）。

```
app-scroll-delta.test.mjs
app-uia-contract.test.mjs
arch-graph-cycles.test.mjs
arch-graph-domains.test.mjs
card02-askuser-normalize.test.mjs
conc02-inbound-limits.test.mjs
disabled-plumbing.test.mjs
doc01-build-sync-parity.test.mjs
eng01-stream-state-sync.test.mjs
eng10-crash-policy.test.mjs
hud-stability.test.mjs
inst01-userdata-migrate.test.mjs
pkg01-runtime-personal-data.test.mjs
pkg02-public-dupe.test.mjs
qa05-dist-stale.test.mjs
screen-key-parity.test.mjs
screen-text-parity.test.mjs
sec01-read-gate.test.mjs
sec07-knowledge-trash-audit.test.mjs
sess07-index-rebuild.test.mjs
system-inject-mark.test.mjs
ui11-rail-registry.test.mjs
```

## C 组：断言宿主产物 / 内核↔宿主 parity（15 个）

纯内核行为之外还断言了宿主的产物或一致性（`server/bridge.mjs` 的拒绝清单、`docs/tool-descriptions.md`、
i18n 文案、`design/`、`electron/` 打包字段等）。**内核代码本身仍被同名域的其他测试覆盖**，
这里排除的只是"与宿主对齐"那部分断言。

```
app-console-tabs.test.mjs
app-ipc-contract.test.mjs
atomic-write-durability.test.mjs
chat-mode.test.mjs
diag01-python-single-source.test.mjs
doc-anchors-reproducible.test.mjs
experience-dedup.test.mjs
knowledge-scope-plumbing.test.mjs
loop-meta-durability.test.mjs
pkg04-license.test.mjs
prompt-file-loud.test.mjs
settings-layers.test.mjs
tool-schema-budget.test.mjs
ui19-evolution-timestamp.test.mjs
ui24-i18n-key-coverage.test.mjs
```

## D 组：需要宿主二进制样本（1 个，位于 `shared/`）

```
shared/office-merge.test.mjs   # 依赖 server/office-fixtures/*.docx|xlsx（宿主侧样本，228K）
```

## 反向说明：为通过测试而一并同步的非 `kernel/` 文件

这几个不是"工具"，但内核测试真的依赖它们，所以一并进了本仓：

- `workflows/gen-review/workflow.yml` —— `workflow-genreview.test.mjs` 要真跑这个工作流定义；
- `scripts/bench-knowledge-index.mjs`、`scripts/eval-retrieval.mjs` —— 知识索引基准/召回评估（只依赖 `kernel/`、`shared/`）；
- `scripts/migrate-team-container.cjs` —— 团队容器迁移（无本地依赖，纯 Node）。
