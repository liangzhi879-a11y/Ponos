/**
 * P5a 样板应用 spec（`specVersion: 2` 的**真源**，不是文档里的片段）
 *
 * 三个用途，同一份内容：
 *   ① **验收判据**：设计稿要求"手写一个 specVersion:2 的样板应用：校验器全绿；
 *      换主题观感跟随；故意塞 className / 未知组件 ⇒ 红"—— 测试直接吃这份，不另抄一份；
 *   ② **生成参照**：LLM 产 `ui` 段时以它为形状基准（版式从 L3 里选，不自由发挥排版）；
 *   ③ **预览兜底**：SpecEditor 的「预览」页在没有真实结果时也能渲染出结构。
 *
 * 它必须**永远**能通过 `validateAppSpec`（`src/lib/appSpecSample.test.ts` 钉着）——
 * 样板一旦不合法，等于给模型发了一份错误的示例。
 */
export const SAMPLE_APP_SPEC = Object.freeze({
  specVersion: 2,
  appId: 'app-sample',
  name: '样板应用',
  desc: 'P5a 验收用的最小可用应用：一条只读命令 + 一个报表视图',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'version', kind: 'read', label: '查看版本', steps: [{ tool: 'Bash', input: { command: 'echo 1.0.0' } }] },
  ],
  // 数据面：视图只从这里取（视图层不发起请求）
  results: { commands: [{ action: 'version', kind: 'read', description: '查看版本' }] },
  selected: { action: 'version' },
  ui: {
    layout: 'report-table',
    views: [
      {
        id: 'commands',
        component: 'DataTable',
        props: {
          rows: '{{results.commands}}',
          density: 'cozy',
          rowActions: ['run'],
          columns: [
            { key: 'action', label: '命令', wrap: true },
            { key: 'kind', label: '类型', truncate: true, tone: 'muted' },
            { key: 'description', label: '说明', wrap: true },
          ],
        },
      },
      { id: 'selected', component: 'StatCard', props: { label: '当前选中', value: '{{selected.action}}', icon: 'play' } },
    ],
    actions: [{ id: 'run', label: '执行命令', command: 'version', kind: 'read' }],
    states: {
      empty: { component: 'EmptyState', props: { text: '还没有可执行的命令', hint: '先执行一次命令，结果会出现在这里。' } },
      error: { component: 'ErrorState', props: { text: '命令没有执行成功' } },
      loading: { component: 'LoadingState', props: { text: '正在执行命令并汇总结果' } },
    },
  },
})
