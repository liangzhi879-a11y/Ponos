# -*- coding: utf-8 -*-
"""生成受控的测试 docx：标题层级 + 正文 + 混合 run 格式 + 表格，
结构贴近真实业务文档（方案/报告类）。用于块级解析稳定性实验。

用法：
    python gen_docx.py [输出路径]
    # 不传参数时输出到「输出目录」（env `YFW_FIXTURE_OUT` 或系统临时目录）+ base.docx

移植自 scratch/collab-experiment/gen_docx.py（2026-09-14 协同可行性实验）。
改写点：**去掉「输出到当前工作目录」的隐式约定** —— 输出路径由参数/env 注入，
默认系统临时目录，避免污染仓库或依赖调用方的 CWD。

**为什么这个脚本要入库**：`base.docx` 的关键字节已入库，但「其余变体由生成脚本在测试时
生成」需要有脚本可跑。本脚本还承担一条不变量：它生成的文档，其 `docx_edit.py read`
输出必须与入库的 `base.docx` **完全相同**（见 docx-python.test.mjs）——一旦入库语料
被误替换或脚本漂移，该断言立刻变红。
"""
import os
import sys
import tempfile

from docx import Document

DEFAULT_OUTROOT = os.environ.get('YFW_FIXTURE_OUT') or tempfile.gettempdir()
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DEFAULT_OUTROOT, 'base.docx')

doc = Document()

# 标题层级（对应 docx_edit.py 的 h1/h2/h3）
doc.add_heading('项目实施方案', level=1)

doc.add_paragraph('本方案旨在描述项目的总体实施路径、阶段划分与交付物定义，供项目组内部评审使用。')
doc.add_paragraph('方案编制依据为需求说明书 v2 与三次评审会议纪要，实施周期预计为十二周。')

# 混合 run 格式段落 —— Word 重存最容易重切 run 的地方
p = doc.add_paragraph()
p.add_run('【重点】')
r = p.add_run('本阶段需要')
r.bold = True
p.add_run('确认数据口径与统计范围')
r2 = p.add_run('，避免后续返工。')
r2.italic = True

doc.add_heading('一、背景与目标', level=2)
doc.add_paragraph('现有系统在数据采集环节依赖人工录入，效率较低且易出错，亟需自动化改造。')
doc.add_paragraph('本期目标为打通采集、校验、汇总三个环节，形成可复用的标准流程。')

doc.add_heading('1.1 现状分析', level=3)
doc.add_paragraph('当前流程共涉及四个岗位、七个环节，其中三个环节存在重复录入。')
doc.add_paragraph('历史数据表明，人工录入环节的错误率约为百分之三，是主要风险点。')

# 表格 1 —— 刻意插在两段正文之间（不是文末），用于暴露「表格被堆到末尾」的 B3
t1 = doc.add_table(rows=3, cols=3)
t1.style = 'Table Grid'
hdr = ['环节', '责任人', '耗时（天）']
for i, h in enumerate(hdr):
    t1.rows[0].cells[i].text = h
for i, row in enumerate([['数据采集', '张三', '5'], ['数据校验', '李四', '3']], start=1):
    for j, v in enumerate(row):
        t1.rows[i].cells[j].text = v

doc.add_paragraph('上表列出的耗时不含评审等待时间，实际周期需额外预留五个工作日。')

doc.add_heading('二、实施计划', level=2)
doc.add_paragraph('实施分为三个阶段：准备期、执行期、验收期，各阶段交付物见下表。')
doc.add_paragraph('阶段之间设置评审节点，未通过评审不得进入下一阶段。')

t2 = doc.add_table(rows=2, cols=4)
t2.style = 'Table Grid'
for i, h in enumerate(['阶段', '起止', '交付物', '验收标准']):
    t2.rows[0].cells[i].text = h
for j, v in enumerate(['准备期', 'W1-W3', '需求确认书', '评审通过']):
    t2.rows[1].cells[j].text = v

doc.add_paragraph('本方案自评审通过之日起生效，修订需经项目组三分之二以上成员同意。')

doc.save(OUT)
print('generated:', OUT)
