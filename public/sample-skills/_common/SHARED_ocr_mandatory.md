# SHARED: OCR强制规范 — 所有 gxtz-* 技能必须遵守

> **核心铁律**：看不到的图片扫描件，必须先OCR确认内容，再执行任何后续操作。
> **绝不允许**通过文件标题猜测内容。OCR无论多慢都必须等待完成。
>
> 来源：用户指令（2026-07-28宏日嘉项目总结）
> 适用范围：所有 gxtz-* 系列技能，无一例外

---

## 铁律一：先OCR，后操作

任何图片型文件（PDF扫描件、JPG、PNG、TIFF等），在执行提取、分析、分类、命名等任何操作前，**必须先执行OCR获取真实内容**。

```
正确流程：
  文件 → detect-scan检测 → 是扫描件 → OCR识别 → 基于OCR结果操作
                                    ↓
                              是文本型 → 直接提取文本 → 基于文本操作

错误流程（严禁）：
  文件 → 看文件名猜测内容 → 基于猜测操作 ✗
  文件 → OCR超时放弃 → 跳过此文件继续 ✗
```

## 铁律二：不得通过文件标题猜测内容

| ❌ 严禁 | ✓ 必须 |
|---------|--------|
| "文件名里有'合同'二字，就是合同" | OCR识别后确认是否合同 |
| "文件名是RD01-xxx.pdf，属于RD01" | OCR识别后提取RD编号验证 |
| "文件在IP目录下，就是IP材料" | OCR识别后提取证书号/专利号确认 |
| "扫描件太多，先猜一下内容再补OCR" | 全部OCR完成后再汇总分析 |
| "这个文件内容可能不重要，跳过" | 每个扫描件都必须OCR |

**文件名不可信的原因**：
- 文件名可能被手动重命名过，与实际内容不一致
- 同一目录下可能混入不相关的文件
- 文件命名可能存在笔误或版本混淆

## 铁律三：OCR必须等待完成

| 情况 | 处理方式 |
|------|---------|
| OCR单页需30-40秒 | 正常等待，不中断 |
| 100页PDF需30分钟 | 分批处理，每批完成后汇报进度 |
| OCR中途报错 | 修复错误后重试，不跳过 |
| 网络/磁盘IO慢 | 等待，不使用缓存过期数据 |

**agent 在OCR等待期间应**：
- 向用户汇报OCR进度（已处理X/Y页）
- 不要提前基于"预计内容"编写任何材料
- OCR全部完成后，汇总识别结果再继续

## 铁律四：OCR结果为空 = 文件异常，必须报错

OCR识别完成后必须校验结果：

```
OCR完成 → 检查结果
  ├─ text非空 → 正常，继续后续操作
  ├─ text为空 → 异常！停止操作，汇报用户：
  │    "文件 [路径] OCR识别结果为空，可能原因：
  │     ① 文件为空白页/损坏
  │     ② 图片过于模糊无法识别
  │     ③ 文件格式不兼容
  │     请人工确认后重试"
  └─ confidence < 0.5 → 警告用户识别质量低，建议人工复核
```

## OCR操作SOP（标准操作流程）

```
步骤0：检查OCR引擎可用性
  python ocr_engine.py --help
  失败 → 安装依赖: pip install rapidocr-openvino rapidocr-onnxruntime onnxruntime

步骤1：扫描检测（所有PDF必经）
  python ocr_engine.py detect --file "<文件路径>"
  ↓
  输出解读：
    is_scanned=true → 扫描件，进入步骤2
    is_scanned=false → 文本型PDF，直接读取
    is_mixed=true → 混合型，auto模式逐页处理

步骤2：OCR识别
  python ocr_engine.py ocr --file "<文件路径>" --project "<项目名>"
  ↓
  输出含：
    - text: 完整识别文本
    - pages: 逐页识别结果
    - confidence: 平均置信度
    - processing_time_seconds: 耗时

步骤3：结果校验
  ✓ text非空 → 继续
  ✗ text为空 → 报错停止
  ⚠ confidence < 0.5 → 警告

步骤4：缓存确认
  检查 .trae/ocr_cache/<项目名>/ 目录
  确认缓存已生成，下次同文件秒级命中
```

## OCR可用工具速查

| 工具 | 用途 | 命令 |
|------|------|------|
| `ocr_engine.py detect` | 检测是否扫描件/混合型 | `--file <path>` |
| `ocr_engine.py ocr` | 全量OCR识别 | `--file <path> --project <name>` |
| `ocr_engine.py cache-list` | 查看OCR缓存 | `--project <name>` |
| `doc_toolkit.py read --mode auto` | 智能读取PDF（自动OCR） | `--file <path> --project <name>` |
| `doc_toolkit.py detect-scan` | 扫描件检测 | `--file <path>` |

## OCR性能参考（v2026-07-28优化后）

| 后端 | 单页耗时（A4扫描件） | 安装方式 |
|------|---------------------|---------|
| **rapidocr-openvino**（推荐） | 15-20秒 | `pip install rapidocr-openvino` |
| rapidocr-onnxruntime | 20-30秒 | `pip install rapidocr-onnxruntime` |

优化要点（已内置于 ocr_engine.py）：
- 渲染DPI从2.0降至1.5（像素减少44%）
- RGB→灰度化渲染（数据量减少75%）
- 消除PNG编解码往返（直接numpy数组传输）
- 主线程预渲染 + 线程池并行OCR
- OCR结果缓存（同文件同项目秒级命中）

## 违反铁律的后果

agent 违反以上任一铁律时：
1. 产出的材料内容不可信（基于猜测而非文件内容）
2. 可能导致申报材料张冠李戴（文件名≠实际内容）
3. 一旦被审计抽查发现材料内容与名称不符，直接导致申报失败

**宁可慢，不可错。OCR再慢也比重新申报快。**
