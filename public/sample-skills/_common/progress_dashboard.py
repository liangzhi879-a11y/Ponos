#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
progress_dashboard.py - HTML看板生成器 v1.0.0

用法：
  python progress_dashboard.py generate --project-root "." --output "0000_项目进度/index.html"

生成自包含HTML进度看板，包含：
  - 多项目Tab切换
  - 资料完整度面板（卡片网格 + SVG进度环）
  - 工作阶段进度面板（垂直时间线）
  - 核心数据汇总卡片
  - 用户备忘贴系统（可拖拽、增删改、localStorage持久化）
  - 交互编辑（新增项目弹窗）
"""

import argparse
import json
import os
import sys
from datetime import datetime


def load_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def generate_dashboard(project_root, output_path):
    progress = load_json(os.path.join(project_root, ".trae", "project_progress.json"))
    types_config = load_json(os.path.join(project_root, ".trae", "project_types_config.json"))
    progress_json = json.dumps(progress, ensure_ascii=False)
    types_json = json.dumps(types_config, ensure_ascii=False)

    html = HTML_TEMPLATE.replace("__PROGRESS_DATA__", progress_json)
    html = html.replace("__TYPES_DATA__", types_json)
    html = html.replace("__GENERATED_AT__", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"OK: 进度看板已生成: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="HTML看板生成器")
    subparsers = parser.add_subparsers(dest="command")

    cmd_gen = subparsers.add_parser("generate")
    cmd_gen.add_argument("--project-root", default=".")
    cmd_gen.add_argument("--output", default="0000_项目进度/index.html")

    args = parser.parse_args()

    if args.command == "generate":
        output_path = os.path.join(args.project_root, args.output) if not os.path.isabs(args.output) else args.output
        generate_dashboard(args.project_root, output_path)
    else:
        parser.print_help()


HTML_TEMPLATE = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>项目进度看板</title>
<style>
:root {
  --primary: #2563EB; --primary-light: #DBEAFE;
  --success: #16A34A; --success-light: #DCFCE7;
  --warning: #F59E0B; --warning-light: #FEF3C7;
  --danger: #DC2626; --danger-light: #FEE2E2;
  --neutral: #6B7280; --neutral-light: #F3F4F6;
  --bg: #F8FAFC; --card-bg: #FFFFFF;
  --text: #1E293B; --text-secondary: #64748B;
  --border: #E2E8F0; --shadow: 0 1px 3px rgba(0,0,0,0.08);
  --radius: 10px; --radius-sm: 6px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--text); min-width:1024px; line-height:1.6; }
.header { background:linear-gradient(135deg,#1E3A5F,#2563EB); color:#fff; padding:16px 32px; display:flex; align-items:center; justify-content:space-between; }
.header h1 { font-size:20px; font-weight:600; letter-spacing:.5px; }
.header-info { font-size:13px; opacity:.85; }
.container { max-width:1400px; margin:0 auto; padding:20px 24px; }
.tabs { display:flex; gap:4px; margin-bottom:20px; flex-wrap:wrap; }
.tab { padding:8px 18px; border-radius:var(--radius-sm) var(--radius-sm) 0 0; cursor:pointer; font-size:14px; font-weight:500; color:var(--text-secondary); background:var(--neutral-light); border:1px solid var(--border); transition:all .15s; }
.tab:hover { color:var(--primary); background:var(--primary-light); }
.tab.active { color:#fff; background:var(--primary); border-color:var(--primary); }
.tab-btn { margin-left:auto; padding:6px 14px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; color:var(--primary); background:var(--primary-light); border:1px dashed var(--primary); transition:all .15s; }
.tab-btn:hover { background:var(--primary); color:#fff; }
.section-title { font-size:16px; font-weight:600; color:var(--text); margin-bottom:14px; display:flex; align-items:center; gap:8px; }
.section-title::before { content:''; width:4px; height:20px; background:var(--primary); border-radius:2px; }
.panel { background:var(--card-bg); border-radius:var(--radius); padding:20px 24px; margin-bottom:20px; box-shadow:var(--shadow); border:1px solid var(--border); }
.summary-cards { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
.summary-card { flex:1; min-width:120px; background:var(--card-bg); border-radius:var(--radius-sm); padding:14px 16px; text-align:center; border:1px solid var(--border); box-shadow:var(--shadow); }
.summary-card .num { font-size:28px; font-weight:700; color:var(--primary); }
.summary-card .label { font-size:12px; color:var(--text-secondary); margin-top:2px; }
.overall-bar { background:var(--neutral-light); border-radius:20px; height:12px; overflow:hidden; margin:8px 0 4px; }
.overall-bar-fill { height:100%; border-radius:20px; background:linear-gradient(90deg,#2563EB,#16A34A); transition:width .6s ease; }
.overall-label { font-size:13px; color:var(--text-secondary); text-align:right; }
.material-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
.material-card { background:var(--card-bg); border-radius:var(--radius-sm); padding:16px; border:1px solid var(--border); transition:box-shadow .15s; display:flex; gap:14px; align-items:center; }
.material-card:hover { box-shadow:0 2px 8px rgba(0,0,0,0.1); }
.material-ring { flex-shrink:0; }
.material-info { flex:1; min-width:0; }
.material-name { font-size:14px; font-weight:500; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.material-stats { font-size:12px; color:var(--text-secondary); }
.material-stats span { margin-right:10px; }
.material-stats .v { color:var(--success); }
.material-stats .e { color:var(--warning); }
.material-stats .i { color:var(--danger); }
.material-badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:500; }
.badge-required { background:var(--danger-light); color:var(--danger); }
.badge-optional { background:var(--neutral-light); color:var(--neutral); }
.badge-done { background:var(--success-light); color:var(--success); }
.timeline { position:relative; padding-left:32px; }
.timeline::before { content:''; position:absolute; left:14px; top:0; bottom:0; width:2px; background:var(--border); }
.timeline-item { position:relative; margin-bottom:18px; }
.timeline-dot { position:absolute; left:-22px; top:4px; width:14px; height:14px; border-radius:50%; border:2px solid var(--border); background:var(--bg); z-index:1; }
.timeline-dot.completed { background:var(--success); border-color:var(--success); }
.timeline-dot.in_progress { background:var(--primary); border-color:var(--primary); animation:pulse 2s infinite; }
.timeline-dot.blocked { background:var(--danger); border-color:var(--danger); }
@keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,0.4)} 50%{box-shadow:0 0 0 6px rgba(37,99,235,0)} }
.timeline-header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.timeline-name { font-size:14px; font-weight:600; }
.timeline-status { font-size:11px; padding:2px 10px; border-radius:10px; font-weight:500; }
.ts-completed { background:var(--success-light); color:var(--success); }
.ts-in_progress { background:var(--primary-light); color:var(--primary); }
.ts-blocked { background:var(--danger-light); color:var(--danger); }
.ts-not_started { background:var(--neutral-light); color:var(--neutral); }
.timeline-steps { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.timeline-step { font-size:12px; padding:3px 10px; border-radius:12px; background:var(--neutral-light); color:var(--text-secondary); }
.timeline-step.done { background:var(--success-light); color:var(--success); }
.timeline-time { font-size:11px; color:var(--text-secondary); margin-top:4px; }
.sticky-container { position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:100; }
.sticky-note { position:absolute; width:200px; min-height:100px; border-radius:4px; box-shadow:2px 3px 10px rgba(0,0,0,0.15); cursor:move; pointer-events:auto; font-size:13px; line-height:1.5; resize:both; overflow:hidden; display:flex; flex-direction:column; }
.sticky-note .sticky-content { flex:1; padding:10px 14px 6px; min-height:60px; outline:none; overflow:auto; cursor:text; }
.sticky-note .sticky-content:focus { }
.sticky-note .sticky-actions { padding:0 8px 6px; display:flex; justify-content:flex-end; gap:4px; cursor:default; user-select:none; }
.sticky-note .sticky-actions button { background:none; border:none; cursor:pointer; font-size:12px; padding:2px 8px; border-radius:3px; opacity:.6; }
.sticky-note .sticky-actions button:hover { opacity:1; background:rgba(0,0,0,0.1); }
.sticky-yellow { background:#FEF9C3; }
.sticky-pink { background:#FCE7F3; }
.sticky-blue { background:#DBEAFE; }
.sticky-green { background:#DCFCE7; }
.add-sticky { position:fixed; bottom:24px; right:24px; width:44px; height:44px; border-radius:50%; background:var(--primary); color:#fff; border:none; font-size:24px; cursor:pointer; box-shadow:0 3px 12px rgba(37,99,235,0.4); z-index:101; display:flex; align-items:center; justify-content:center; transition:transform .15s; }
.add-sticky:hover { transform:scale(1.1); }
.modal-overlay { display:none; position:fixed; top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4); z-index:200; align-items:center;justify-content:center; }
.modal-overlay.show { display:flex; }
.modal { background:var(--card-bg); border-radius:var(--radius); padding:24px; width:480px; max-height:80vh; overflow:auto; box-shadow:0 8px 30px rgba(0,0,0,0.2); }
.modal h3 { margin-bottom:16px; font-size:18px; }
.modal label { display:block; font-size:13px; font-weight:500; margin-bottom:4px; color:var(--text-secondary); }
.modal input,.modal select,.modal textarea { width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px; margin-bottom:12px; }
.modal textarea { resize:vertical; min-height:60px; }
.modal-btns { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
.btn { padding:8px 20px; border-radius:var(--radius-sm); font-size:14px; cursor:pointer; border:none; font-weight:500; transition:all .15s; }
.btn-primary { background:var(--primary); color:#fff; }
.btn-primary:hover { opacity:.9; }
.btn-ghost { background:transparent; color:var(--text-secondary); border:1px solid var(--border); }
.btn-ghost:hover { background:var(--neutral-light); }
.btn-danger { background:var(--danger); color:#fff; }
.btn-sm { padding:4px 12px; font-size:12px; }
.empty-state { text-align:center; padding:40px; color:var(--text-secondary); }
.empty-state .icon { font-size:48px; margin-bottom:12px; }
@media print { .sticky-container,.add-sticky,.modal-overlay,.tab-btn { display:none!important; } .sticky-note { position:static!important; margin:8px 0; } }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>项目进度看板</h1>
  </div>
  <div class="header-info">生成时间: __GENERATED_AT__</div>
</div>

<div class="container">
  <div class="tabs" id="tabBar"></div>

  <div id="dashboardContent"></div>
</div>

<div class="sticky-container" id="stickyContainer"></div>
<button class="add-sticky" id="addStickyBtn" title="添加备忘贴">+</button>

<div class="modal-overlay" id="modalOverlay">
  <div class="modal" id="modalContent"></div>
</div>

<script id="progress-data" type="application/json">__PROGRESS_DATA__</script>
<script id="types-data" type="application/json">__TYPES_DATA__</script>

<script>
(function(){
var progressData = JSON.parse(document.getElementById('progress-data').textContent);
var typesData = JSON.parse(document.getElementById('types-data').textContent);
var activeProjectId = null;
var STICKY_KEY = 'gxtz_progress_sticky_notes';

function getStickyNotes(){
  try { return JSON.parse(localStorage.getItem(STICKY_KEY)) || {}; }
  catch(e){ return {}; }
}
function saveStickyNotes(data){
  localStorage.setItem(STICKY_KEY, JSON.stringify(data));
}

function progressRing(pct, size){
  var r = (size||44)/2 - 4;
  var circ = 2 * Math.PI * r;
  var offset = circ * (1 - pct/100);
  var color = pct>=80 ? '#16A34A' : pct>=50 ? '#F59E0B' : pct>0 ? '#DC2626' : '#CBD5E1';
  return '<svg width="'+(size||44)+'" height="'+(size||44)+'" viewBox="0 0 '+(size||44)+' '+(size||44)+'">'
    +'<circle cx="'+(size||44)/2+'" cy="'+(size||44)/2+'" r="'+r+'" fill="none" stroke="#E2E8F0" stroke-width="3"/>'
    +'<circle cx="'+(size||44)/2+'" cy="'+(size||44)/2+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="3" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90 '+(size||44)/2+' '+(size||44)/2+')"/>'
    +'<text x="'+(size||44)/2+'" y="'+(size||44)/2+'" text-anchor="middle" dy=".35em" font-size="'+(size>50?'12':'10')+'px" font-weight="600" fill="#1E293B">'+(pct||0)+'%</text>'
    +'</svg>';
}

function statusBadge(s){
  var map = {completed:{c:'ts-completed',t:'已完成'},in_progress:{c:'ts-in_progress',t:'进行中'},blocked:{c:'ts-blocked',t:'已阻塞'},not_started:{c:'ts-not_started',t:'未开始'}};
  var m = map[s]||map.not_started;
  return '<span class="timeline-status '+m.c+'">'+m.t+'</span>';
}

function renderAll(){
  var projects = progressData.projects || [];
  var tabBar = document.getElementById('tabBar');
  var content = document.getElementById('dashboardContent');

  tabBar.innerHTML = '';
  if(projects.length===0){
    tabBar.innerHTML = '<div class="empty-state"><div class="icon">📋</div><div>暂无项目，点击 "+" 新增项目</div></div>';
    document.getElementById('tabBar').innerHTML += '<button class="tab-btn" onclick="showAddProject()">+ 新增项目</button>';
    content.innerHTML = '';
    return;
  }

  projects.forEach(function(p){
    var typeCfg = typesData[p.type] || {};
    var icon = typeCfg.icon || '📁';
    var cls = p.id===activeProjectId ? 'tab active' : 'tab';
    tabBar.innerHTML += '<div class="'+cls+'" data-pid="'+p.id+'">'+icon+' '+p.name+'</div>';
  });
  tabBar.innerHTML += '<button class="tab-btn" onclick="showAddProject()">+ 新增项目</button>';

  if(!activeProjectId || !projects.find(function(p){return p.id===activeProjectId;})){
    activeProjectId = projects[0].id;
  }

  var project = projects.find(function(p){return p.id===activeProjectId;});
  if(!project){ content.innerHTML=''; return; }

  renderProject(project, content);
  renderStickyNotes();
}

function renderProject(project, container){
  var typeCfg = typesData[project.type] || {};
  var stages = project.stages || [];
  var materials = project.materials || [];
  var summary = project.data_summary || {};

  var completedStages = stages.filter(function(s){return s.status==='completed';}).length;
  var overallPct = stages.length>0 ? Math.round(completedStages/stages.length*100) : 0;

  var html = '';

  html += '<div class="panel">';
  html += '<div class="section-title">📋 整体进度</div>';
  html += '<div style="display:flex;align-items:center;gap:20px;margin-bottom:12px;">';
  html += '<div style="font-size:36px;font-weight:700;color:var(--primary);">'+overallPct+'%</div>';
  html += '<div style="flex:1;"><div class="overall-bar"><div class="overall-bar-fill" style="width:'+overallPct+'%"></div></div>';
  html += '<div class="overall-label">'+completedStages+'/'+stages.length+' 阶段完成</div></div></div>';

  html += '<div class="summary-cards">';
  if(project.type==='gxtz'){
    html += '<div class="summary-card"><div class="num">'+(summary.ip_count||0)+'</div><div class="label">知识产权(IP)</div></div>';
    html += '<div class="summary-card"><div class="num">'+(summary.rd_count||0)+'</div><div class="label">研发项目(RD)</div></div>';
    html += '<div class="summary-card"><div class="num">'+(summary.ps_count||0)+'</div><div class="label">高新产品(PS)</div></div>';
    html += '<div class="summary-card"><div class="num">'+(summary.achievement_count||0)+'</div><div class="label">成果转化</div></div>';
    html += '<div class="summary-card"><div class="num">'+(summary.staff_count||0)+'</div><div class="label">科技人员</div></div>';
  } else {
    var matComplete = materials.filter(function(m){return m.completeness_pct>=100;}).length;
    html += '<div class="summary-card"><div class="num">'+materials.length+'</div><div class="label">材料类别</div></div>';
    html += '<div class="summary-card"><div class="num">'+matComplete+'</div><div class="label">已完备</div></div>';
  }
  html += '<div class="summary-card"><div class="num">'+(project.last_skill_run||'—')+'</div><div class="label">最近技能</div></div>';
  html += '</div></div>';

  html += '<div class="panel">';
  html += '<div class="section-title">📊 资料完整度</div>';
  html += '<div class="material-grid">';
  materials.forEach(function(m){
    var pct = m.completeness_pct || 0;
    html += '<div class="material-card">';
    html += '<div class="material-ring">'+progressRing(pct,48)+'</div>';
    html += '<div class="material-info">';
    html += '<div class="material-name">'+m.category_name+' '
      +(m.required?'<span class="material-badge badge-required">必传</span>':'<span class="material-badge badge-optional">可选</span>')+'</div>';
    html += '<div class="material-stats">';
    html += '<span class="v">✓'+m.valid_count+'</span>';
    html += '<span class="e">⏳'+m.expired_count+'</span>';
    html += '<span class="i">✗'+m.invalid_count+'</span>';
    html += '<span>共'+m.total_files+'文件</span>';
    html += '</div></div></div>';
  });
  html += '</div></div>';

  html += '<div class="panel">';
  html += '<div class="section-title">📈 工作阶段进度</div>';
  html += '<div class="timeline">';
  stages.forEach(function(s,i){
    var dotClass = s.status==='completed'?'completed':s.status==='in_progress'?'in_progress':s.status==='blocked'?'blocked':'';
    html += '<div class="timeline-item">';
    html += '<div class="timeline-dot '+dotClass+'"></div>';
    html += '<div class="timeline-header">';
    html += '<div class="timeline-name">'+s.name+'</div>';
    html += statusBadge(s.status);
    html += '<button class="btn btn-sm btn-ghost" onclick="toggleStageStatus(\''+project.id+'\',\''+s.id+'\')" title="切换状态">↻</button>';
    html += '</div>';
    html += '<div class="timeline-steps">';
    (s.steps||[]).forEach(function(st){
      html += '<div class="timeline-step '+(st.status==='completed'?'done':'')+'">'+st.name+'</div>';
    });
    html += '</div>';
    if(s.started_at||s.completed_at){
      html += '<div class="timeline-time">';
      if(s.started_at) html += '开始: '+s.started_at+' ';
      if(s.completed_at) html += '完成: '+s.completed_at;
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div></div>';

  container.innerHTML = html;

  document.querySelectorAll('.tab').forEach(function(t){
    t.classList.toggle('active', t.getAttribute('data-pid')===activeProjectId);
  });
}

function toggleStageStatus(pid, sid){
  var project = progressData.projects.find(function(p){return p.id===pid;});
  if(!project) return;
  var stage = (project.stages||[]).find(function(s){return s.id===sid;});
  if(!stage) return;
  var order = ['not_started','in_progress','completed','blocked'];
  var idx = order.indexOf(stage.status);
  stage.status = order[(idx+1)%order.length];
  var now = new Date().toISOString().slice(0,10);
  if(stage.status==='in_progress'&&!stage.started_at) stage.started_at=now;
  if(stage.status==='completed'){ stage.completed_at=now; (stage.steps||[]).forEach(function(st){st.status='completed';}); }
  document.getElementById('progress-data').textContent = JSON.stringify(progressData);
  renderAll();
}

window.showAddProject = function(){
  var overlay = document.getElementById('modalOverlay');
  var modal = document.getElementById('modalContent');
  var types = Object.keys(typesData).map(function(k){return '<option value="'+k+'">'+typesData[k].name+' ('+k+')</option>';}).join('');
  modal.innerHTML = '<h3>新增项目</h3>'
    +'<label>项目名称</label><input id="newProjectName" placeholder="如: XX科技-2026高新认定">'
    +'<label>项目类型</label><select id="newProjectType">'+types+'</select>'
    +'<label>企业名称</label><input id="newEnterprise" placeholder="如: 云充科技">'
    +'<label>申报年份</label><input id="newYear" type="number" value="2026">'
    +'<label>子目录路径</label><input id="newSubPath" placeholder="留空为根目录，或输入如 技术合同项目">'
    +'<div class="modal-btns"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="addProject()">确认新增</button></div>';
  overlay.classList.add('show');
};

window.addProject = function(){
  var name = document.getElementById('newProjectName').value.trim();
  var type = document.getElementById('newProjectType').value;
  var enterprise = document.getElementById('newEnterprise').value.trim();
  var year = parseInt(document.getElementById('newYear').value)||2026;
  var sub = document.getElementById('newSubPath').value.trim()||'.';
  if(!name){ alert('请输入项目名称'); return; }
  var pid = 'proj_'+Date.now();
  var typeCfg = typesData[type]||{};
  var stages = (typeCfg.stages||[]).map(function(s){
    return {id:s.id,name:s.name,order:s.order,depends_on:s.depends_on||[],parallel_group:s.parallel_group,
      steps:(s.steps||[]).map(function(st){return {name:st.name,skills:st.skills||[],status:'not_started'};}),
      status:'not_started',started_at:'',completed_at:''};
  });
  var materials = (typeCfg.material_categories||[]).map(function(m){
    return {category_id:m.id,category_name:m.name,directory:m.dir_pattern,required:m.required||false,
      expected_min:m.expected_min||0,valid_count:0,expired_count:0,invalid_count:0,total_files:0,completeness_pct:0,files:[]};
  });
  progressData.projects.push({
    id:pid, name:name, type:type, sub_path:sub, enterprise:enterprise, year:year,
    overall_status:'not_started', stages:stages, materials:materials,
    data_summary:{ip_count:0,rd_count:0,ps_count:0,achievement_count:0,staff_count:0,total_employees:0,rd_expenses_total:0,revenue_total:0},
    last_scan_at:'', last_skill_run:''
  });
  document.getElementById('progress-data').textContent = JSON.stringify(progressData);
  closeModal();
  renderAll();
};

window.closeModal = function(){
  document.getElementById('modalOverlay').classList.remove('show');
};

function renderStickyNotes(){
  var container = document.getElementById('stickyContainer');
  container.innerHTML = '';
  var allNotes = getStickyNotes();
  var notes = allNotes[activeProjectId] || [];
  notes.forEach(function(n){
    var wrapper = document.createElement('div');
    wrapper.className = 'sticky-note sticky-'+n.color;
    wrapper.style.left = n.x+'px';
    wrapper.style.top = n.y+'px';
    wrapper.setAttribute('data-id', n.id);
    wrapper.addEventListener('mousedown', function(e){ startDrag(e, wrapper, n.id); });

    var content = document.createElement('div');
    content.className = 'sticky-content';
    content.contentEditable = 'true';
    content.innerHTML = (n.content||'').replace(/\n/g,'<br>');
    content.addEventListener('blur', function(){ saveNoteContent(n.id, content.innerText); });

    var actions = document.createElement('div');
    actions.className = 'sticky-actions';
    actions.innerHTML = '<button onclick="changeNoteColor(\''+n.id+'\')" title="换色">🎨</button><button onclick="deleteNote(\''+n.id+'\')" title="删除">✕</button>';

    wrapper.appendChild(content);
    wrapper.appendChild(actions);
    container.appendChild(wrapper);
  });
}

var dragTarget = null, dragOffsetX=0, dragOffsetY=0, dragNoteId=null;
function startDrag(e, el, noteId){
  if(e.target.tagName==='BUTTON' || e.target.closest('.sticky-content')) return;
  dragTarget = el; dragNoteId = noteId;
  dragOffsetX = e.clientX - el.offsetLeft;
  dragOffsetY = e.clientY - el.offsetTop;
  el.style.zIndex = 200;
}
document.addEventListener('mousemove', function(e){
  if(!dragTarget) return;
  dragTarget.style.left = (e.clientX-dragOffsetX)+'px';
  dragTarget.style.top = (e.clientY-dragOffsetY)+'px';
});
document.addEventListener('mouseup', function(){
  if(!dragTarget) return;
  dragTarget.style.zIndex = '';
  var notes = getStickyNotes();
  var list = notes[activeProjectId]||[];
  var n = list.find(function(x){return x.id===dragNoteId;});
  if(n){ n.x = parseInt(dragTarget.style.left)||0; n.y = parseInt(dragTarget.style.top)||0; saveStickyNotes(notes); }
  dragTarget = null; dragNoteId = null;
});

function saveNoteContent(id, content){
  var notes = getStickyNotes();
  var list = notes[activeProjectId]||[];
  var n = list.find(function(x){return x.id===id;});
  if(n){ n.content = content; n.updated_at = new Date().toISOString(); saveStickyNotes(notes); }
}

window.changeNoteColor = function(id){
  var colors = ['yellow','pink','blue','green'];
  var notes = getStickyNotes();
  var list = notes[activeProjectId]||[];
  var n = list.find(function(x){return x.id===id;});
  if(n){ var idx = colors.indexOf(n.color); n.color = colors[(idx+1)%colors.length]; saveStickyNotes(notes); renderStickyNotes(); }
};

window.deleteNote = function(id){
  if(!confirm('删除这张备忘贴？')) return;
  var notes = getStickyNotes();
  notes[activeProjectId] = (notes[activeProjectId]||[]).filter(function(x){return x.id!==id;});
  saveStickyNotes(notes);
  renderStickyNotes();
};

document.getElementById('addStickyBtn').addEventListener('click', function(){
  var notes = getStickyNotes();
  if(!notes[activeProjectId]) notes[activeProjectId] = [];
  var note = {id:'note_'+Date.now(), content:'双击编辑内容', x:200+Math.random()*200, y:200+Math.random()*100, color:'yellow', created_at:new Date().toISOString(), updated_at:''};
  notes[activeProjectId].push(note);
  saveStickyNotes(notes);
  renderStickyNotes();
});

document.getElementById('tabBar').addEventListener('click', function(e){
  if(e.target.classList.contains('tab')){
    activeProjectId = e.target.getAttribute('data-pid');
    renderAll();
  }
});

renderAll();
})();
</script>
</body>
</html>'''


if __name__ == "__main__":
    main()
