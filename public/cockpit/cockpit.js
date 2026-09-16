"use strict";

/* ================================================================
 * Boost 驾驶舱 · Sierpinski 三角拼贴（应用集成版）
 *
 *   思路：
 *     - 全屏 pointy-top 规则正三角网格（边长 L=50px）
 *     - logo 的 Y 字外轮廓（7 顶点）精确映射到屏幕坐标，
 *       轮廓内的三角挖除（形成 logo 周围的"洞"）
 *     - 6 个按钮 = 4 个小三角拼成的 2L 大三角，围绕 logo 分布
 *       （悬停 → 切角矩形悬浮卡；点击 → 右侧详细面板）
 *     - 中央 logo 可点击 = 中枢：面板未开时上报 yfw:hub-click
 *       进入工作台；面板开着时点击只收起（不上报）
 *
 *   轮廓映射（精确对齐，任意窗口尺寸）：
 *     USER_OUTLINE 取自 logo-outline-1789007505127.svg 红色线段
 *     （1054×810 画布坐标）。该画布中的 logo 线稿与 boost.svg
 *     （viewBox 544×378）中的 logo 线稿为同一图形：
 *       boost = outline × 1.598 + (-570.15, -406.55)
 *     显示时 boost 空间按 logo 显示尺寸等比缩放并居中于 (CX, CY)，
 *     轮廓随之缩放 → 洞始终贴合 logo。
 *
 *   消息桥（iframe ⇄ 父窗口，与 CockpitScreen.tsx 契约逐条对齐，2026-09-10 设计语言统一后）：
 *     父 → 本页：{ type:'yfw:theme', theme:'dark'|'light'|'dark-glass',
 *                  speedMode:boolean, glassOpacity:number }
 *                { type:'yfw:overview', data: overview|null }
 *     本页 → 父：{ type:'yfw:ready' }
 *                { type:'yfw:hub-click' }（logo 点击且无面板打开）
 *     主题：完全由主程序驱动（?theme= 首帧 + yfw:theme 热切），本页无独立明暗开关、
 *           不再上报 yfw:theme-change（已废弃）。玻璃主题由 --glass-opacity 联动透明度。
 *     overview shape: { runningTasks:{title,status:'exec'|'wait'|'idle',progress?,meta?}[],
 *                       agents:{id,role,state:'run'|'idle'|'think'|'review'}[],
 *                       usage:{token,requests,costUsd},
 *                       skills:{count,sample[]}, health:{engine,kernel} }
 * ================================================================ */

/* ================================================================
 * 轮廓与映射常量
 * ================================================================ */
/* Y 字外轮廓（7 顶点，1054×810 画布坐标） */
const USER_OUTLINE = [
  { x: 355.3, y: 269.9 },
  { x: 703.6, y: 269.7 },
  { x: 625.7, y: 381.9 },
  { x: 582.4, y: 381.9 },
  { x: 514.8, y: 478.6 },
  { x: 383.8, y: 478.3 },
  { x: 442.7, y: 394.2 },
];
/* 轮廓画布 → boost.svg viewBox(544×378) 的仿射变换 */
const OUTLINE_TO_BOOST = { scale: 1.598, tx: -570.15, ty: -406.55 };
const BOOST_VIEW_W = 544;
const BOOST_VIEW_H = 378;
/* 参考 logo 显示比例（原型调优窗口 1058×756 下 lw/544 ≈ 0.584）：
   按钮布局的距离约束按 s/REF_S 缩放，保持各窗口下的相对布局一致 */
const REF_S = 0.584;

/* ================================================================
 * 状态
 * ================================================================ */
const STATE = {
  W: 0, H: 0, CX: 0, CY: 0,
  logoS: 1,            // logo 显示比例 s = lw/544
  logoLW: 0, logoLH: 0,
  outline: [],         // 屏幕坐标轮廓（layout 时重算）
  /* 轮廓在 boost 空间的运行时校正量：logo 的辉光向右下延展，
     实心 Sierpinski 图形居中时整体观感偏右下；图片加载后
     实测可见内容包围盒中心，把洞移到该中心上（updateOutlineOffset） */
  outlineOffset: { x: 0, y: 0 },
  tris: [],
  selectedIdx: -1,
  hoverIdx: -1,
};
let OUTLINE_EDGES = [];
let LOGO_CENTER = { x: 0, y: 0 };

/* ================================================================
 * 6 个按钮模块（4 个小三角 → 1 个 2L 大三角按钮）
 *   图标：Lucide（messages-square / list-checks / bot / library /
 *   bar-chart-3 / settings）；模块与驾驶舱六功能一一对应
 *
 *   route = 该模块的**真入口**（2026-09-15）：点击详情面板里的主按钮后，
 *   经 yfw:nav 上抛给主程序，由 ViewRouter 解析并导航到真实功能
 *   （rail / rail+次级浮层 / 独立工具窗）。route 的合法值由主程序侧白名单判定，
 *   本页只负责"按已声明的意图上报"，不做合法性假设。
 *   cta = 入口按钮文案（各模块不同，避免"进入 →"这种无信息量的统一文案）。
 * ================================================================ */
const BUTTON_MODULES = [
  { id: 'sessions', name: '会话',       en: 'Sessions',    icon: 'messages-square', cta: '进入会话',   route: { rail: 'chat' },                  sub: '与工作流对话、并行多会话协作，A/B 上下文不串扰。' },
  { id: 'tasks',    name: '任务',       en: 'Tasks',       icon: 'list-checks',     cta: '进入任务',   route: { rail: 'task' },                  sub: '任务编排、自动执行与进度追踪，可并行的子任务矩阵。' },
  { id: 'agents',   name: '智能体矩阵', en: 'Agent',       icon: 'bot',             cta: '进入智能体', route: { rail: 'agents' },                sub: '多智能体协同工作，各司其职，通过矩阵调度统一编排。' },
  { id: 'kb',       name: '知识库',     en: 'Knowledge',   icon: 'library',         cta: '进入知识库', route: { rail: 'knowledge' },             sub: '沉淀项目事实、检索增强与跨会话的工作记忆。' },
  { id: 'usage',    name: '用量统计',   en: 'Usage',       icon: 'bar-chart-3',     cta: '用量明细',   route: { rail: 'task', secondTab: 'usage' }, sub: 'Token 消耗、请求规模与成本估算的实时视图。' },
  { id: 'settings', name: '设置',       en: 'Settings',    icon: 'settings',        cta: '打开设置',   route: { utility: 'settings' },           sub: '偏好、模型、输出与安全选项的集中控制台。' },
];
const BTN_TARGET_ANGLES = [-90, -30, 30, 90, 150, 210];  // 度，屏幕 y 向下

/* Lucide 图标（SVG path data，viewBox 24×24） */
const LUCIDE_ICONS = {
  'messages-square': '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  'list-checks':     '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  'bot':             '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  'library':         '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  'bar-chart-3':     '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  'settings':        '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

/* ================================================================
 * 几何工具
 * ================================================================ */
function rng(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
function centroid(p1, p2, p3) { return { x: (p1.x + p2.x + p3.x) / 3, y: (p1.y + p2.y + p3.y) / 3 }; }
function triangleInViewport(t, W, H) {
  const c = centroid(t.p1, t.p2, t.p3);
  const r = Math.max(dist(c, t.p1), dist(c, t.p2), dist(c, t.p3));
  if (c.x + r < -40 || c.x - r > W + 40) return false;
  if (c.y + r < -40 || c.y - r > H + 40) return false;
  return true;
}
/* 点到线段距离 */
function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}
function pointToOutlineDist(px, py) {
  let min = Infinity;
  for (const e of OUTLINE_EDGES) {
    const d = pointToSegDist(px, py, e.a.x, e.a.y, e.b.x, e.b.y);
    if (d < min) min = d;
  }
  return min;
}
/* 射线法判断点是否在闭合多边形内 */
function pointInOutline(px, py) {
  const pts = STATE.outline;
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ================================================================
 * 轮廓映射：outline 画布坐标 → 屏幕坐标
 *   boost = outline × 1.598 + (-570.15, -406.55) + outlineOffset
 *   screen = (CX - lw/2 + boost.x × s, CY - lh/2 + boost.y × s)
 * ================================================================ */
function outlineBoostPoint(p) {
  const T = OUTLINE_TO_BOOST;
  return {
    x: p.x * T.scale + T.tx + STATE.outlineOffset.x,
    y: p.y * T.scale + T.ty + STATE.outlineOffset.y,
  };
}
function mapOutlineToScreen() {
  const s = STATE.logoS, lw = STATE.logoLW, lh = STATE.logoLH;
  STATE.outline = USER_OUTLINE.map(p => {
    const b = outlineBoostPoint(p);
    return { x: STATE.CX - lw / 2 + b.x * s, y: STATE.CY - lh / 2 + b.y * s };
  });
  OUTLINE_EDGES = STATE.outline.map((p, i) => ({
    a: p, b: STATE.outline[(i + 1) % STATE.outline.length],
  }));
  let cx = 0, cy = 0;
  STATE.outline.forEach(p => { cx += p.x; cy += p.y; });
  LOGO_CENTER = { x: cx / STATE.outline.length, y: cy / STATE.outline.length };
}

/* ================================================================
 * 轮廓居中校正：boost.svg 的辉光向右下延展，实心图形居中时
 * 整体观感偏右下。图片加载后把 logo 渲染到离屏画布，实测可见
 * 内容（含辉光）的 alpha 包围盒中心，将洞的包围盒中心移到该点。
 * ================================================================ */
function updateOutlineOffset() {
  const img = document.getElementById('logoSvg');
  if (!img || !img.complete || !img.naturalWidth) return;
  const cv = document.createElement('canvas');
  cv.width = BOOST_VIEW_W; cv.height = BOOST_VIEW_H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, BOOST_VIEW_W, BOOST_VIEW_H);
  let data;
  try { data = ctx.getImageData(0, 0, BOOST_VIEW_W, BOOST_VIEW_H).data; }
  catch (e) { return; }   /* 画布被污染等异常：保持原始位置 */
  let minx = BOOST_VIEW_W, miny = BOOST_VIEW_H, maxx = -1, maxy = -1;
  for (let y = 0; y < BOOST_VIEW_H; y++) {
    for (let x = 0; x < BOOST_VIEW_W; x++) {
      if (data[(y * BOOST_VIEW_W + x) * 4 + 3] > 16) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < minx) return;   /* 无可见内容 */
  const vcx = (minx + maxx) / 2, vcy = (miny + maxy) / 2;
  /* 轮廓原始位置（offset=0）在 boost 空间的包围盒中心 */
  const saved = STATE.outlineOffset;
  STATE.outlineOffset = { x: 0, y: 0 };
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  USER_OUTLINE.forEach(p => {
    const b = outlineBoostPoint(p);
    if (b.x < bx0) bx0 = b.x; if (b.x > bx1) bx1 = b.x;
    if (b.y < by0) by0 = b.y; if (b.y > by1) by1 = b.y;
  });
  STATE.outlineOffset = saved;
  const dx = vcx - (bx0 + bx1) / 2;
  const dy = vcy - (by0 + by1) / 2;
  if (Math.abs(dx - saved.x) < 0.5 && Math.abs(dy - saved.y) < 0.5) return;
  STATE.outlineOffset = { x: dx, y: dy };
  layout();
}

/* ================================================================
 * 主算法：全屏 pointy-top 规则三角网格 + logo 挖洞 + 按钮布局
 *   scale = s/REF_S：按钮距离约束随 logo 显示比例缩放
 * ================================================================ */
function buildMosaic(scale) {
  STATE.tris = [];
  const W = STATE.W, H = STATE.H;

  const L = 50;
  const rowH = L * Math.sqrt(3) / 2;
  const pad = L * 3;
  const x0 = -pad, y0 = -pad;
  const EDGE_DIST = Math.min(W, H) * 0.020;

  const rows = Math.ceil((H + 2 * pad) / rowH) + 2;
  const cols = Math.ceil((W + 2 * pad) / L) + 3;
  /* 网格顶点：第 k 层 y = y0 + k*rowH，x = x0 + j*L + (k%2)*(L/2) */
  const V = (k, j) => ({ x: x0 + j * L + (k % 2) * (L / 2), y: y0 + k * rowH });

  // ---- 1) 生成原始三角（不抖动），同时挖掉 logo 内部 ----
  const raw = [];
  const rawIdx = new Map();
  const keyOf = (pts) => pts
    .map(p => Math.round(p.x * 100) + ',' + Math.round(p.y * 100))
    .sort().join('|');
  /* 挖洞：任一顶点在轮廓内、或重心在轮廓内都移除——
     重心在内而顶点全在外的三角横跨轮廓，角部会戳进 logo 区域 */
  const outside = (A, B, C) =>
    !pointInOutline(A.x, A.y) && !pointInOutline(B.x, B.y) && !pointInOutline(C.x, C.y) &&
    !pointInOutline((A.x + B.x + C.x) / 3, (A.y + B.y + C.y) / 3);

  for (let k = 0; k < rows; k++) {
    for (let j = -1; j < cols; j++) {
      const a = V(k, j), b = V(k, j + 1);
      const even = (k % 2 === 0);
      const upTop = even ? V(k - 1, j)     : V(k - 1, j + 1);  // 朝上三角的顶点
      const dnBot = even ? V(k + 1, j)     : V(k + 1, j + 1);  // 朝下三角的顶点
      if (outside(a, b, upTop)) {
        rawIdx.set(keyOf([a, b, upTop]), raw.length);
        raw.push({ p1: a, p2: b, p3: upTop, inverted: false });
      }
      if (outside(a, b, dnBot)) {
        rawIdx.set(keyOf([a, b, dnBot]), raw.length);
        raw.push({ p1: a, p2: b, p3: dnBot, inverted: true });
      }
    }
  }

  // ---- 2) 计算 6 个按钮布局（4 子三角 → 1 个 2L 大三角） ----
  computeButtonLayout(V, rows, cols, rawIdx, L, rowH, scale);

  // ---- 3) 标记按钮三角 ----
  const btnOf = new Map();   // rawIdx → moduleId
  BUTTON_MODULES.forEach(bm => {
    if (bm.tris) bm.tris.forEach(i => btnOf.set(i, bm.id));
  });

  // ---- 4) 抖动 + 落定 ----
  const rnd = rng(7);
  const stateIdxOf = new Map();   // rawIdx → STATE.tris 索引
  raw.forEach((t, i) => {
    const moduleId = btnOf.get(i) || null;
    const isButton = !!moduleId;
    let { p1, p2, p3 } = t;
    // 按钮三角不抖动；边缘贴合带不抖动；其余轻微抖动
    if (!isButton) {
      const d1 = pointToOutlineDist(p1.x, p1.y);
      const d2 = pointToOutlineDist(p2.x, p2.y);
      const d3 = pointToOutlineDist(p3.x, p3.y);
      const onEdge = Math.min(d1, d2, d3) < EDGE_DIST;
      if (!onEdge) {
        const j = 1.0;
        p1 = { x: p1.x + (rnd() - 0.5) * 2 * j, y: p1.y + (rnd() - 0.5) * 2 * j };
        p2 = { x: p2.x + (rnd() - 0.5) * 2 * j, y: p2.y + (rnd() - 0.5) * 2 * j };
        p3 = { x: p3.x + (rnd() - 0.5) * 2 * j, y: p3.y + (rnd() - 0.5) * 2 * j };
        // 抖动后若侵入 logo 则丢弃
        if (pointInOutline(p1.x, p1.y) || pointInOutline(p2.x, p2.y) || pointInOutline(p3.x, p3.y)) return;
      }
    }
    const size = Math.min(
      Math.hypot(p1.x - p2.x, p1.y - p2.y),
      Math.hypot(p2.x - p3.x, p2.y - p3.y),
      Math.hypot(p3.x - p1.x, p3.y - p1.y),
    );
    const tri = {
      p1, p2, p3, size,
      inverted: t.inverted,
      isButton,
      buttonModuleId: moduleId,
    };
    if (!triangleInViewport(tri, W, H)) return;
    stateIdxOf.set(i, STATE.tris.length);
    STATE.tris.push(tri);
  });

  // ---- 5) 回填 bm.tris：raw 索引 → STATE.tris 索引（保持引用有效） ----
  // 注意：computeButtonLayout 每次 layout 都会重新求解 raw 索引，
  // 这里直接映射即可，不能跨 layout 缓存（resize 后 raw 网格已变）
  BUTTON_MODULES.forEach(bm => {
    if (!bm.tris) return;
    bm.tris = bm.tris
      .map(ri => stateIdxOf.get(ri))
      .filter(si => si !== undefined);
  });
}

/* ================================================================
 * 计算 6 个按钮的布局
 *   大三角 4 分裂（边长 2L → 4 个 L 子三角），4 个子三角都必须在
 *   raw 中（未被 logo 挖洞裁掉）；大三角重心距轮廓 ≥ 140×scale、
 *   距 logo 中心 130~520×scale，且包围盒完整落在窗口内。
 *   按 6 个目标方位角度就近选取。
 * ================================================================ */
function computeButtonLayout(V, rows, cols, rawIdx, L, rowH, scale) {
  const keyOf = (pts) => pts
    .map(p => Math.round(p.x * 100) + ',' + Math.round(p.y * 100))
    .sort().join('|');
  const used = new Set();
  /* 距 logo 轮廓：约 3.2 排（原型在参考窗口下的有效间隙即约 3.7 排；
     若按 4 排硬约束，顶部按钮顶点会被挤出窗口上缘而裁切） */
  const minOutlineDist = 140 * scale;
  const distMin = 130 * scale;                      // 距 logo 中心下限
  const distMax = 520 * scale;                      // 距 logo 中心上限
  /* 大三角（边长 2L）相对重心的包围盒范围 */
  const extL = L, extR = L;
  const extT = 2 * L * Math.sqrt(3) / 3;            // 重心 → 顶点
  const extB = 2 * L * Math.sqrt(3) / 6;            // 重心 → 底边

  BUTTON_MODULES.forEach((bm, mi) => {
    const targetAng = BTN_TARGET_ANGLES[mi % BTN_TARGET_ANGLES.length] * Math.PI / 180;
    let best = null, bestScore = Infinity;

    for (let k0 = 2; k0 < rows - 2; k0++) {
      for (let j0 = -1; j0 < cols; j0++) {
        const even = (k0 % 2 === 0);
        // 4 个子三角的顶点（按 k0 奇偶分支）
        const subs = even ? [
          [V(k0 - 1, j0 - 1), V(k0 - 1, j0),     V(k0 - 2, j0)],       // 子1 上
          [V(k0,   j0 - 1), V(k0,   j0),     V(k0 - 1, j0 - 1)],     // 子2 左下
          [V(k0,   j0),   V(k0,   j0 + 1),   V(k0 - 1, j0)],       // 子3 右下
          [V(k0 - 1, j0 - 1), V(k0 - 1, j0), V(k0,   j0)],       // 子4 中
        ] : [
          [V(k0 - 1, j0),   V(k0 - 1, j0 + 1),   V(k0 - 2, j0)],
          [V(k0,   j0 - 1), V(k0,   j0),     V(k0 - 1, j0)],
          [V(k0,   j0),   V(k0,   j0 + 1),   V(k0 - 1, j0 + 1)],
          [V(k0 - 1, j0),   V(k0 - 1, j0 + 1), V(k0,   j0)],
        ];
        // 4 个子三角都必须在 raw 中且未被占用
        const idxs = [];
        let ok = true;
        for (const s of subs) {
          const idx = rawIdx.get(keyOf(s));
          if (idx === undefined) { ok = false; break; }
          if (used.has(idx)) { ok = false; break; }
          idxs.push(idx);
        }
        if (!ok) continue;

        // 大三角重心 = (X, Y - 2h/3)
        const base = V(k0, j0);
        const h = L * Math.sqrt(3) / 2;
        const gcx = base.x;
        const gcy = base.y - h * 2 / 3;
        // 距 logo 轮廓约束
        if (pointToOutlineDist(gcx, gcy) < minOutlineDist) continue;
        // 视口安全：按钮包围盒须完整落在窗口内（留 4px 边距），
        // 防止顶部按钮顶点被窗口边缘裁切；放不下则放弃该候选
        if (gcx - extL < 4 || gcx + extR > STATE.W - 4 ||
            gcy - extT < 4 || gcy + extB > STATE.H - 4) continue;
        // 距 logo 中心的距离区间
        const dx = gcx - LOGO_CENTER.x, dy = gcy - LOGO_CENTER.y;
        const d = Math.hypot(dx, dy);
        if (d < distMin || d > distMax) continue;
        // 角度差
        const ang = Math.atan2(dy, dx);
        let dAng = ang - targetAng;
        while (dAng >  Math.PI) dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        dAng = Math.abs(dAng);
        /* 主要按角度择优，其次偏好更靠近 logo（避免顶到屏幕边缘/顶栏） */
        const score = dAng * 420 + d * 0.5;
        if (score < bestScore) {
          bestScore = score;
          best = { idxs, gcx, gcy, ang };
        }
      }
    }

    if (best) {
      best.idxs.forEach(i => used.add(i));
      bm.tris = best.idxs;
      bm.center = { x: best.gcx, y: best.gcy };
      bm.size = 2 * L;
      bm.btnAngle = best.ang;
    } else {
      bm.tris = null;
      bm.center = { x: LOGO_CENTER.x, y: LOGO_CENTER.y };
    }
  });
}

/* ================================================================
 * 渲染
 * ================================================================ */
const NS = 'http://www.w3.org/2000/svg';

function renderTriCanvas() {
  const svg = document.getElementById('triCanvas');
  svg.setAttribute('viewBox', `0 0 ${STATE.W} ${STATE.H}`);
  Array.from(svg.children).forEach(el => el.remove());

  if (STATE.tris.length > 6000) {
    /* 超大窗口（4K 等）裁剪到 6000，但保留按钮三角 */
    const keep = new Set();
    BUTTON_MODULES.forEach(bm => (bm.tris || []).forEach(i => keep.add(i)));
    STATE.tris = STATE.tris.filter((t, i) => keep.has(i) || i < 6000);
  }

  /* 统一极简渲染：淡细线框背景 + 按钮填色（无密度场） */
  renderDensity(svg);

  /* 邻接表随 tris 定型（裁剪后）重建：hover 光晕的邻居查询必须与当前索引一致 */
  buildNeighbors();

  // 按钮图标（Lucide）压在按钮三角之上
  renderButtonIcons(svg);

  bindTriInteractions(svg);
}

function triPath(t) {
  return `M ${t.p1.x.toFixed(2)} ${t.p1.y.toFixed(2)} L ${t.p2.x.toFixed(2)} ${t.p2.y.toFixed(2)} L ${t.p3.x.toFixed(2)} ${t.p3.y.toFixed(2)} Z`;
}

/* 极简渲染：背景三角统一淡细线框（无密度场），仅按钮填色 */
function isLightTheme() {
  // 只认 .theme-light 本身：className 里还有 cockpit-speed 等类，
  // 用词边界而非 ^$ 锚定（旧的双浅色正则已随浅色玻璃主题删除收敛为单值）
  return /(^|\s)theme-light(\s|$)/.test(document.documentElement.className || '');
}
function renderDensity(svg) {
  const isLight = isLightTheme();
  STATE.tris.forEach((t, i) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', triPath(t));
    path.dataset.idx = i;
    path.classList.add('tri');
    if (t.isButton) {
      /* 按钮三角：单一色系半透明填充 + 细亮描边（浅色主题降低透明度） */
      path.setAttribute('fill', isLight ? 'rgba(255,116,41,.25)' : 'rgba(255,116,41,.42)');
      path.setAttribute('stroke', 'rgba(255,206,170,.72)');
      path.setAttribute('stroke-width', '0.9');
      path.style.cursor = 'pointer';
    } else {
      /* 背景三角：仅极淡细线框，通透（随主题变色） */
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--tri-stroke)');
      path.setAttribute('stroke-width', '0.6');
    }
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  });
}

/* 在按钮中心绘制 Lucide 图标（白色线条，压在深色按钮之上） */
function renderButtonIcons(svg) {
  BUTTON_MODULES.forEach(bm => {
    if (!bm.tris || !bm.center) return;
    const icon = LUCIDE_ICONS[bm.icon];
    if (!icon) return;
    const size = 24;
    const s = size / 24;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform',
      `translate(${(bm.center.x - size / 2).toFixed(1)}, ${(bm.center.y - size / 2).toFixed(1)}) scale(${s.toFixed(3)})`);
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', '#FFFFFF');
    g.setAttribute('stroke-width', '2');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.setAttribute('data-btn-icon', bm.id);
    g.style.pointerEvents = 'none';
    g.style.filter = 'drop-shadow(0 1px 3px rgba(0,0,0,.55))';
    g.innerHTML = icon;
    svg.appendChild(g);
  });
}

/* ================================================================
 * 邻接表（2026-09-15 hover 光晕）
 *   共顶点的三角互为邻居：hover 时邻居做柔和衰减，形成"该三角放大、
 *   周围平缓过渡"的聚焦感。
 *   在 layout 期一次性建表（顶点键 → 三角索引）——若改成 hover 时
 *   遍历全部三角求邻居，4K 窗口下每次 mouseenter 都是 O(n²)，会明显卡顿。
 * ================================================================ */
const NEIGHBORS = [];   // 索引 → 邻居索引数组
function buildNeighbors() {
  NEIGHBORS.length = 0;
  const byVertex = new Map();
  STATE.tris.forEach((t, i) => {
    NEIGHBORS[i] = [];
    // 顶点键不带索引号：同一顶点在不同三角里必须折叠为同一个键
    [t.p1, t.p2, t.p3].forEach(p => {
      const k = Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000);
      let arr = byVertex.get(k);
      if (!arr) { arr = []; byVertex.set(k, arr); }
      arr.push(i);
    });
  });
  byVertex.forEach(arr => {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        NEIGHBORS[arr[a]].push(arr[b]);
        NEIGHBORS[arr[b]].push(arr[a]);
      }
    }
  });
}

/* 清除某索引的 hover 视觉（自身 tri-hover + 邻居 tri-near） */
function clearHoverVisual(idx) {
  if (idx < 0) return;
  const self = document.querySelector(`#triCanvas path[data-idx="${idx}"]`);
  if (self) self.classList.remove('tri-hover');
  (NEIGHBORS[idx] || []).forEach(n => {
    const el = document.querySelector(`#triCanvas path[data-idx="${n}"]`);
    if (el) el.classList.remove('tri-near');
  });
}

function bindTriInteractions(svg) {
  const paths = svg.querySelectorAll('path.tri');
  paths.forEach(p => {
    const idx = +p.dataset.idx;
    p.addEventListener('mouseenter', e => onHover(idx, e));
    p.addEventListener('mousemove',  e => moveTip(e));
    p.addEventListener('mouseleave', () => onLeave(idx));
    p.addEventListener('click',      e => onClick(idx, e));
  });
}
function onHover(idx, e) {
  if (STATE.hoverIdx >= 0 && STATE.hoverIdx !== idx) clearHoverVisual(STATE.hoverIdx);
  STATE.hoverIdx = idx;
  const p = document.querySelector(`#triCanvas path[data-idx="${idx}"]`);
  if (p) {
    p.classList.add('tri-hover');
    /* 放大 1.22 后需压住邻居（否则放大的一角会被邻三角描边切断）：
       插到首个按钮图标 <g> 之前——既在全部 path 之上，又不遮按钮图标。 */
    const svg = document.getElementById('triCanvas');
    const anchor = svg.querySelector('g[data-btn-icon]');
    if (anchor) svg.insertBefore(p, anchor); else svg.appendChild(p);
  }
  /* 邻居柔和衰减（.tri-near 带 CSS transition ⇒ 进出都是缓动，无跳变） */
  (NEIGHBORS[idx] || []).forEach(n => {
    const el = document.querySelector(`#triCanvas path[data-idx="${n}"]`);
    if (el) el.classList.add('tri-near');
  });
  const t = STATE.tris[idx];
  if (!t) return;

  /* 按钮三角：显示悬浮信息卡 */
  if (t.isButton && t.buttonModuleId) {
    const bm = BUTTON_MODULES.find(b => b.id === t.buttonModuleId);
    if (bm) { showHoverPanel(bm); document.getElementById('triTip').classList.remove('show'); return; }
  }

  /* 普通三角：仅点亮（tri-hover 高亮 + 放大） */
  hideHoverPanel();
}
function moveTip(e) {
  const tip = document.getElementById('triTip');
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top  = (e.clientY + 14) + 'px';
}
function onLeave(idx) {
  STATE.hoverIdx = -1;
  clearHoverVisual(idx);
  document.getElementById('triTip').classList.remove('show');
  hideHoverPanel();
}
function onClick(idx, e) {
  const t = STATE.tris[idx];
  if (!t) return;

  /* 按钮三角：打开右侧详细面板 */
  if (t.isButton && t.buttonModuleId) {
    spawnRipple(e.clientX, e.clientY, false);
    setTimeout(() => spawnRipple(e.clientX, e.clientY, true), 80);
    openDetailPanel(t.buttonModuleId);
    return;
  }

  /* 普通三角：选中 + 涟漪 */
  if (STATE.selectedIdx >= 0) {
    const prev = document.querySelector(`#triCanvas path[data-idx="${STATE.selectedIdx}"]`);
    if (prev) prev.classList.remove('tri-selected');
  }
  STATE.selectedIdx = idx;
  const p = document.querySelector(`#triCanvas path[data-idx="${idx}"]`);
  if (p) p.classList.add('tri-selected');
  spawnRipple(e.clientX, e.clientY, false);
  setTimeout(() => spawnRipple(e.clientX, e.clientY, true), 80);
  showToast(
    `选中 #${idx} · ${t.inverted ? '倒三角' : '正三角'}`,
    `边长 ${Math.round(t.size)} · 中心 (${Math.round((t.p1.x + t.p2.x + t.p3.x) / 3)}, ${Math.round((t.p1.y + t.p2.y + t.p3.y) / 3)})`
  );
}
function spawnRipple(x, y, flash) {
  const r = document.createElement('div');
  r.className = 'ripple' + (flash ? ' flash' : '');
  r.style.left = x + 'px';
  r.style.top  = y + 'px';
  document.body.appendChild(r);
  setTimeout(() => r.remove(), 850);
}

/* ================================================================
 * 悬浮信息卡 —— 按钮简要内容（数据由主程序经 yfw:overview 注入，
 * 未注入时显示等待提示）
 * ================================================================ */
const WAIT_HINT = '<div class="hint">等待主程序注入数据…</div>';

function hoverBrief(m) {
  const d = cockpitData;
  if (!d) return WAIT_HINT;
  const hint = '<div class="hint">点击展开详情 · 面板内可进入功能 →</div>';
  switch (m.id) {
    case 'sessions': {
      const t = Array.isArray(d.runningTasks) ? d.runningTasks : null;
      if (!t) return WAIT_HINT;
      if (!t.length) return `<div class="kv"><span>进行中</span><b>0</b></div>${hint}`;
      const ex = t.filter(x => x.status === 'exec').length;
      const wa = t.filter(x => x.status === 'wait').length;
      return `<div class="kv"><span>进行中</span><b>${ex}</b></div>
              <div class="kv"><span>等待</span><b>${wa}</b></div>${hint}`;
    }
    case 'tasks': {
      const t = Array.isArray(d.runningTasks) ? d.runningTasks : null;
      if (!t) return WAIT_HINT;
      if (!t.length) return `<div class="kv"><span>任务</span><b>0</b></div>${hint}`;
      const pr = t.filter(x => typeof x.progress === 'number').length;
      return `<div class="kv"><span>推进中</span><b>${t.length}</b></div>
              <div class="kv"><span>含进度</span><b>${pr}</b></div>${hint}`;
    }
    case 'agents': {
      const a = Array.isArray(d.agents) ? d.agents : null;
      if (!a) return WAIT_HINT;
      if (!a.length) return `<div class="kv"><span>在线智能体</span><b>0</b></div>${hint}`;
      const busy = a.filter(x => (x.state || 'idle') !== 'idle').length;
      return `<div class="kv"><span>在线智能体</span><b>${a.length}</b></div>
              <div class="kv"><span>忙碌</span><b>${busy}</b></div>${hint}`;
    }
    case 'kb': {
      const s = d.skills;
      if (!s) return WAIT_HINT;
      const count = typeof s.count === 'number' ? s.count : 0;
      return `<div class="kv"><span>可用技能</span><b>${count}</b></div>${hint}`;
    }
    case 'usage': {
      const u = d.usage;
      if (!u) return WAIT_HINT;
      return `<div class="kv"><span>今日 Token</span><b>${u.token != null && u.token !== '' ? u.token : '—'}</b></div>
              <div class="kv"><span>请求</span><b>${u.requests != null && u.requests !== '' ? u.requests : '—'}</b></div>${hint}`;
    }
    case 'settings': {
      const h = d.health;
      if (!h) return WAIT_HINT;
      return `<div class="kv"><span>引擎</span><b>${h.engine != null && h.engine !== '' ? h.engine : '—'}</b></div>
              <div class="kv"><span>内核</span><b>${h.kernel != null && h.kernel !== '' ? h.kernel : '—'}</b></div>${hint}`;
    }
    default: return WAIT_HINT;
  }
}

let hoverHideTimer = null;
function showHoverPanel(bm) {
  // 详细面板已打开时不显示悬浮面板
  const dp = document.getElementById('detailPanel');
  if (dp && dp.classList.contains('open')) return;
  if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  const el = document.getElementById('hoverPanel');
  if (!el) return;
  document.getElementById('hpIcon').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${LUCIDE_ICONS[bm.icon] || ''}</svg>`;
  document.getElementById('hpName').textContent = bm.name;
  document.getElementById('hpEn').textContent   = bm.en;
  document.getElementById('hpBody').innerHTML   = hoverBrief(bm);

  const panelW = 278, panelH = 150;
  /* 贴着按钮外侧展开（2026-09-15）：以按钮**外缘**为锚，留 HOVER_GAP 间隙，
     垂直于展开方向居中于按钮；主方向取 |dx| 与 |dy| 中较大者。
     旧实现按 (dx/len)*130 相对 logo 中心偏移，窗口一大就飘离按钮，读起来与按钮脱钩。 */
  const dx = bm.center.x - LOGO_CENTER.x;
  const dy = bm.center.y - LOGO_CENTER.y;
  const half = (bm.size || 100) * 0.42;   // 按钮外接半径近似（大三角边长 2L）
  const HOVER_GAP = 10;
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const side = horiz
    ? (dx >= 0 ? 'right' : 'left')
    : (dy >= 0 ? 'bottom' : 'top');
  let x, y;
  if (horiz) {
    x = dx >= 0 ? bm.center.x + half + HOVER_GAP
                : bm.center.x - half - HOVER_GAP - panelW;
    y = bm.center.y - panelH / 2;
  } else {
    x = bm.center.x - panelW / 2;
    y = dy >= 0 ? bm.center.y + half + HOVER_GAP
                : bm.center.y - half - HOVER_GAP - panelH;
  }
  // 视口收敛：夹紧到窗口内（贴边时可能与按钮重叠，但绝不越界不可见）
  x = Math.max(12, Math.min(window.innerWidth  - panelW - 12, x));
  y = Math.max(12, Math.min(window.innerHeight - panelH - 12, y));
  /* 入场方向按**夹紧后**的相对位置重判：夹紧可能把面板挪到按钮另一侧，
     若仍用夹紧前的方向，滑入动画会从错误的一侧进来（视觉上"跳"一下） */
  let effSide;
  if (x + panelW <= bm.center.x - half + 1) effSide = 'left';
  else if (x >= bm.center.x + half - 1)     effSide = 'right';
  else if (y + panelH <= bm.center.y - half + 1) effSide = 'top';
  else if (y >= bm.center.y + half - 1)     effSide = 'bottom';
  else effSide = side;                            // 重叠（贴边）时保留主方向
  el.classList.remove('side-left', 'side-right', 'side-top', 'side-bottom');
  el.classList.add('side-' + effSide);
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  el.classList.add('show');
}
function hideHoverPanel() {
  const el = document.getElementById('hoverPanel');
  if (!el) return;
  if (hoverHideTimer) clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(() => {
    el.classList.remove('show');
    hoverHideTimer = null;
  }, 120);
}

/* ================================================================
 * 右侧详细面板 —— 6 个模块内容（数据由主程序经 yfw:overview 注入；
 * 无对应注入键显示等待 note；settings 保留静态偏好演示）
 * ================================================================ */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
const WAIT_NOTE = '<div class="dp-note" style="margin-top:0">等待主程序注入数据</div>';
const DATA_NOTE = '<div class="dp-note">· 运行期数据由主程序注入</div>';
const STATUS_TEXT = { exec: '执行中', wait: '等待中', idle: '已就绪' };
const STATUS_CHIP = { exec: 'run', wait: 'wait', idle: 'idle' };
const STATUS_COLOR = { exec: '#FF7429', wait: '#FFB000', idle: '#9AA1AC' };
const DAYS = ['一', '二', '三', '四', '五', '六', '日'];

function detailHtml(m) {
  const d = cockpitData;
  switch (m.id) {
    case 'sessions': {
      if (!d || !Array.isArray(d.runningTasks)) return WAIT_NOTE;
      const list = d.runningTasks;
      if (!list.length) return '<div class="dp-note" style="margin-top:0">暂无运行中的会话任务</div>';
      return `<div class="dp-sec">运行中的会话</div>
      ${list.map(t => {
        const st = STATUS_CHIP[t.status] || 'idle';
        const c = STATUS_COLOR[t.status] || STATUS_COLOR.idle;
        return `<div class="dp-row"><i class="dp-dot" style="background:${c};box-shadow:0 0 8px ${c}"></i>
          <div class="grow"><div class="t">${esc(t.title)}</div>${t.meta ? `<div class="m">${esc(t.meta)}</div>` : ''}</div>
          <span class="dp-chip ${st}">${STATUS_TEXT[t.status] || '已就绪'}</span></div>`;
      }).join('')}${DATA_NOTE}`;
    }
    case 'tasks': {
      if (!d || !Array.isArray(d.runningTasks)) return WAIT_NOTE;
      const list = d.runningTasks;
      if (!list.length) return '<div class="dp-note" style="margin-top:0">暂无任务进度数据</div>';
      return `<div class="dp-sec">任务进度</div>
      ${list.map(t => {
        const st = STATUS_CHIP[t.status] || 'idle';
        const hasProg = typeof t.progress === 'number' && isFinite(t.progress);
        const pct = Math.max(0, Math.min(100, Math.round(t.progress || 0)));
        return `<div class="dp-row"><div class="grow">
          <div class="t">${esc(t.title)}</div>
          <div class="m" style="margin-bottom:6px">${esc(t.meta || (STATUS_TEXT[t.status] || '已就绪'))}</div>
          ${hasProg ? `<div class="dp-bar"><i style="width:${pct}%"></i></div>` : ''}</div>
          <span class="dp-chip ${st}">${hasProg ? pct + '%' : (STATUS_TEXT[t.status] || '已就绪')}</span></div>`;
      }).join('')}${DATA_NOTE}`;
    }
    case 'agents': {
      if (!d || !Array.isArray(d.agents)) return WAIT_NOTE;
      const list = d.agents;
      if (!list.length) return '<div class="dp-note" style="margin-top:0">暂无智能体在线</div>';
      const stateOf = a => {
        const st = (a && a.state) || 'idle';
        if (st === 'think')  return ['思考中', 'run'];
        if (st === 'review') return ['审查', 'wait'];
        if (st === 'run')    return ['执行', 'run'];
        return ['在线', 'idle'];
      };
      return `<div class="dp-sec">智能体矩阵</div>
      <div class="dp-grid">
        ${list.map(a => {
          const [st, cls] = stateOf(a);
          return `<div class="dp-card">
            <div class="t" style="font-size:12.5px;font-weight:700">${esc(a.id)}</div>
            <div class="m" style="margin-top:4px">${esc(a.role || '')}</div>
            <span class="dp-chip ${cls}" style="margin-top:7px;display:inline-block">${st}</span>
          </div>`;
        }).join('')}
      </div>${DATA_NOTE}`;
    }
    case 'kb': {
      if (!d || !d.skills) return WAIT_NOTE;
      const s = d.skills;
      const count = typeof s.count === 'number' ? s.count : 0;
      const sample = Array.isArray(s.sample) ? s.sample.filter(x => x != null && x !== '') : [];
      if (!count && !sample.length) return '<div class="dp-note" style="margin-top:0">暂无技能数据</div>';
      return `<div class="dp-sec">知识库 · 技能</div>
      <div class="dp-row"><i class="dp-dot" style="background:#FF7429"></i>
        <div class="grow"><div class="t">可用技能 / 摘要</div><div class="m">运行期数据由主程序注入</div></div>
        <span class="dp-chip num">${count}</span></div>
      ${sample.length ? `<div class="dp-sec">技能示例</div>${sample.map(q =>
        `<div class="dp-row"><div class="grow"><div class="t" style="font-weight:400">${esc(q)}</div></div></div>`).join('')}` : ''}`;
    }
    case 'usage': {
      if (!d || !d.usage) return WAIT_NOTE;
      const u = d.usage;
      const v = (x, fb) => x != null && x !== '' ? x : fb;
      const ph = [420, 620, 510, 880, 700, 1240, 1284];
      const phMax = Math.max.apply(null, ph);
      return `<div class="dp-sec">今日汇总</div>
      <div class="dp-grid g3">
        <div class="dp-card"><div class="v">${esc(v(u.token, '—'))}</div><div class="k">Token</div></div>
        <div class="dp-card"><div class="v">${esc(v(u.requests, '—'))}</div><div class="k">请求</div></div>
        <div class="dp-card hot"><div class="v">${esc(v(u.costUsd, '—'))}</div><div class="k">估算成本</div></div>
      </div>
      <div class="dp-sec">过去 7 日用量（占位）</div>
      <div class="dp-chart">
        ${ph.map((val, i) => `<div class="c"><i style="height:${Math.max(6, Math.round(val / phMax * 100))}%"></i><span>${DAYS[i]}</span></div>`).join('')}
      </div>${DATA_NOTE}`;
    }
    case 'settings': {
      const health = d && d.health ? d.health : null;
      /* health 缺省值为 '—'（主程序无 engine/kernel 打点时），不展示占位值 */
      const eng = health && health.engine && health.engine !== '—' ? health.engine : '';
      const ker = health && health.kernel && health.kernel !== '—' ? health.kernel : '';
      const tail = (eng || ker)
        ? `<div class="dp-note">· 引擎 ${esc(eng)} · 内核 ${esc(ker)}<br>· 偏好请在主程序设置中修改</div>`
        : `<div class="dp-note">· 偏好请在主程序设置中修改</div>`;
      return `
      <div class="dp-sec">运行偏好</div>
      ${[['飞轮动效', '轨道尘埃与彗星动画渲染', true],
         ['流式输出', '逐字展示回复内容', true],
         ['自动压缩上下文', '接近窗口阈值时先行压缩', true],
         ['声音提示', '任务完成时播放提示音', false],
         ['危险操作确认', '删除/覆盖等操作需确认', false]].map(([t, mm, on]) => `
      <div class="dp-row"><div class="grow"><div class="t">${t}</div><div class="m">${mm}</div></div>
        <div class="dp-sw${on ? ' on' : ''}"></div></div>`).join('')}
      <div class="dp-sec">默认模型</div>
      <div class="dp-row"><div class="grow"><div class="t">Qwen3.8-27B（本地）</div>
        <div class="m">自动路由优先本地推理</div></div></div>
      <div class="dp-sec">输出策略</div>
      <div class="dp-row"><div class="grow"><div class="t">流畅优先</div>
        <div class="m">低延迟流式输出</div></div></div>
      ${tail}`;
    }
    default:
      return WAIT_NOTE;
  }
}

let lastModule = null;
function renderDetailPanel(moduleId) {
  const bm = BUTTON_MODULES.find(b => b.id === moduleId);
  if (!bm) return;
  document.getElementById('dpBody').innerHTML = detailHtml(bm);
  bindDetailControls();
}
function openDetailPanel(moduleId) {
  const bm = BUTTON_MODULES.find(b => b.id === moduleId);
  if (!bm) return;
  lastModule = moduleId;
  document.getElementById('dpOrb').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${LUCIDE_ICONS[bm.icon] || ''}</svg>`;
  document.getElementById('dpName').textContent = bm.name;
  document.getElementById('dpEn').textContent   = bm.en;
  document.getElementById('dpSub').textContent  = bm.sub;
  /* 功能入口按钮：文案随模块变，route 决定去哪儿（点击 → yfw:nav） */
  const cta = document.getElementById('dpCta');
  cta.textContent = bm.cta || '进入';
  cta.dataset.module = moduleId;
  renderDetailPanel(moduleId);
  document.getElementById('detailPanel').classList.add('open');
  document.getElementById('dpVeil').classList.add('on');
  hideHoverPanel();
}
/* 功能入口：把用户真正带进功能（不是停在只读面板）。
   上报的是模块**声明的** route，合法性与导航动作全在主程序侧；
   本页不做合法性假设，也不改自身状态——导航失败时用户仍停在面板上，可重试。 */
function navTo(moduleId) {
  const bm = BUTTON_MODULES.find(b => b.id === moduleId);
  if (!bm || !bm.route) return;
  notifyHost('yfw:nav', { target: bm.route });
}
function closeDetailPanel() {
  document.getElementById('detailPanel').classList.remove('open');
  document.getElementById('dpVeil').classList.remove('on');
}
/* settings 演示开关：点按切换（不持久化，仅交互体验） */
function bindDetailControls() {
  document.querySelectorAll('#dpBody .dp-sw').forEach(sw => {
    sw.addEventListener('click', () => sw.classList.toggle('on'));
  });
}

/* ================================================================
 * 消息桥（iframe ⇄ 父窗口）
 * ================================================================ */
let cockpitData = null;
let cockpitSpeed = false;
const host = window.parent;

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e.data || {};
  if (d.type === 'yfw:theme') {
    applyTheme(d.theme || 'dark');
    if (typeof d.glassOpacity === 'number') {
      document.documentElement.style.setProperty('--glass-opacity', String(d.glassOpacity));
    }
    setSpeed(d.speedMode === true);
  } else if (d.type === 'yfw:overview') {
    cockpitData = d.data || null;
    if (lastModule && document.getElementById('detailPanel').classList.contains('open')) {
      renderDetailPanel(lastModule);
    }
  }
});
function setSpeed(on) {
  cockpitSpeed = on;
  document.documentElement.classList.toggle('cockpit-speed', on);
}
function notifyHost(type, extra) {
  try { host.postMessage(Object.assign({ type: type }, extra || {}), '*') } catch (e) {}
}
function signalReady() {
  if (document.readyState === 'complete') { setTimeout(() => notifyHost('yfw:ready'), 0); }
  else { window.addEventListener('load', () => setTimeout(() => notifyHost('yfw:ready'), 0)); }
}

/* ================================================================
 * 布局
 * ================================================================ */
function layout() {
  STATE.W = innerWidth;
  STATE.H = innerHeight;
  STATE.CX = STATE.W / 2;
  STATE.CY = STATE.H * 0.46;

  /* 中央 logo 显示尺寸（2026-09-15 降低）：0.42/346 → 0.30/248。
     按钮布局的距离约束按 scale = logoS/REF_S 联动，logo 变小则按钮整体收近，
     中央留白随之收敛，视觉重心更低。 */
  const lw = Math.min(Math.min(STATE.W, STATE.H) * 0.30, 248);
  const lh = lw * (378 / 544);
  STATE.logoLW = lw; STATE.logoLH = lh;
  STATE.logoS = lw / BOOST_VIEW_W;

  /* logo 与辉光定位到 (CX, CY) */
  const svg = document.getElementById('logoSvg');
  svg.style.left = STATE.CX + 'px';
  svg.style.top  = STATE.CY + 'px';
  svg.style.width  = lw + 'px';
  svg.style.height = lh + 'px';
  const glow = document.getElementById('logoGlow');
  glow.style.left = STATE.CX + 'px';
  glow.style.top  = STATE.CY + 'px';
  glow.style.width  = (lw * 1.5) + 'px';
  glow.style.height = (lw * 1.5) + 'px';
  /* logo 提示胶囊：logo 底缘下方 */
  const cap = document.getElementById('logoCap');
  cap.style.left = STATE.CX + 'px';
  cap.style.top  = (STATE.CY + lh / 2 + 12) + 'px';

  /* 轮廓映射到屏幕坐标（洞始终贴合 logo） */
  mapOutlineToScreen();

  const scale = STATE.logoS / REF_S;
  buildMosaic(scale);
  renderTriCanvas();
}

/* ================================================================
 * 控件
 * ================================================================ */
let toastTimer = null;
function showToast(title, detail) {
  const el = document.getElementById('toast');
  document.getElementById('toastT').textContent = title;
  document.getElementById('toastD').textContent = detail || '';
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
function clearSelection() {
  if (STATE.selectedIdx >= 0) {
    const prev = document.querySelector(`#triCanvas path[data-idx="${STATE.selectedIdx}"]`);
    if (prev) prev.classList.remove('tri-selected');
  }
  STATE.selectedIdx = -1;
}
/* 主题完全由主程序驱动（?theme= 首帧 + yfw:theme 热切）：本页无独立主题开关，
   只切换 .theme-{dark|light|dark-glass} 并重渲染画布；不回写存储、不上报变更。
   classList 增删（不清空 className，保留 cockpit-speed） */
function applyTheme(id) {
  id = id || 'dark';
  const root = document.documentElement;
  ['dark', 'light', 'dark-glass'].forEach(function (n) {
    root.classList.remove('theme-' + n);
  });
  root.classList.add('theme-' + id);
  renderTriCanvas();
}

/* ================================================================
 * 启动
 * ================================================================ */
document.getElementById('footR').textContent = '会话 / 任务 / 智能体矩阵 / 知识库 / 用量统计 / 设置';

/* 详细面板关闭 */
document.getElementById('dpClose').addEventListener('click', closeDetailPanel);
document.getElementById('dpVeil').addEventListener('click', closeDetailPanel);
/* 功能入口主按钮：当前面板对应模块的 route（moduleId 由 openDetailPanel 写在 dataset） */
document.getElementById('dpCta').addEventListener('click', e => {
  e.stopPropagation();
  navTo(e.currentTarget.dataset.module || '');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDetailPanel(); clearSelection(); }
});
/* 中央 logo = 中枢：面板开着时点击 = 收起（不上报）；
   关闭态点击 = 通知父进入工作界面（与旧驾驶舱 hub 语义一致） */
document.getElementById('logoSvg').addEventListener('click', () => {
  if (document.getElementById('detailPanel').classList.contains('open')) { closeDetailPanel(); return; }
  notifyHost('yfw:hub-click');
});

/* 应用主题：首帧前 head 脚本已按主程序 ?theme= 加 class，这里同步画布；
   本页无独立主题开关，运行期变化由 yfw:theme 消息驱动（消息桥上方已接）。
   三值：dark / light / dark-glass（非法值回落 dark） */
let initTheme = 'dark';
try {
  const _q = new URLSearchParams(location.search).get('theme');
  if (['dark', 'light', 'dark-glass'].includes(_q)) initTheme = _q;
} catch (e) {}
applyTheme(initTheme);
setSpeed(false);   /* speedMode 初值：默认动效开启，主程序经 yfw:theme 下发 */

/* resize 防抖：优先 rAF（正常渲染环境 ~16ms），
   兜底 setTimeout（rAF 被节流的环境，如后台标签/某些嵌入场景） */
let resizePending = false;
function scheduleLayout() {
  if (resizePending) return;
  resizePending = true;
  let done = false;
  const run = () => { if (done) return; done = true; resizePending = false; layout(); };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}
window.addEventListener('resize', scheduleLayout);
layout();
signalReady();   /* 首帧就绪后向父广播 yfw:ready */

/* logo 图片加载完成后实测可见内容中心，校正轮廓（洞）位置，
   使 logo（含辉光）整体居中于洞中 */
{
  const _img = document.getElementById('logoSvg');
  if (_img.complete && _img.naturalWidth) updateOutlineOffset();
  else _img.addEventListener('load', updateOutlineOffset, { once: true });
}
