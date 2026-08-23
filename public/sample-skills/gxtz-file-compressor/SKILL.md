---
name: "gxtz-file-compressor"
description: "申报材料文件压缩技能。当用户需要压缩PDF/图片以满足申报系统大小要求时调用。v1.0.0初始版本：五级递进压缩+彩色优先ultra+自适应DPI估算。"
version: "1.0.0"
---

<!-- SECTION_BEGIN: ocr_mandatory -->
## OCR强制规范 → 详见 {{PONOS_SKILLS}}/_common/SHARED_ocr_mandatory.md
> ⚠️ 核心铁律：先OCR后操作，禁止猜测，必须等待，结果空则报错。
> 速查：`python ocr_engine.py detect --file <path>` → `python ocr_engine.py ocr --file <path> --project <project>`
<!-- SECTION_END: ocr_mandatory -->

# gxtz-file-compressor — 申报材料文件压缩

高新技术企业认定申报材料文件压缩技能。当用户需要压缩 PDF/图片以满足申报系统大小要求时调用。

---

## 触发条件

- 用户提到：压缩、文件太大、PDF压缩、图片压缩、文件超标、减小体积
- 上下文涉及：申报系统上传、材料合规、文件大小、PS材料、IP材料、RD材料
- 命令：`/compress` 或 `python file_compressor.py`

## 交互流程

本技能启动后执行以下标准流程：

### 第零步完：确认进度依赖（v1.0.0新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-file-compressor"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{PONOS_SKILLS}}/gxtz-progress-manager/SKILL.md`


### 1. 确认压缩目标
询问用户（如有不明确处）：
- **源文件路径**：要压缩的文件
- **材料类型**（可选）：IP/RD/PS/ACHIEVEMENT/营业执照/财务审计报告 等，自动匹配目标大小
- **自定义大小**（可选）：如材料类型不在预设列表，直接指定 MB 数
- **颜色偏好**：彩色优先（默认）还是灰度（体积更小）
- **快速模式**：已知是扫描件/图片密集PDF时可用 `--quick` 直跳 ultra，大幅节省时间

### 2. 执行压缩
调用 `_common/file_compressor.py`：

```
# 按材料类型自动压缩
python file_compressor.py auto --input <源文件> --type PS --output <输出路径>

# 检查是否合规
python file_compressor.py check --input <源文件> --type PS

# 自定义目标大小
python file_compressor.py compress --input <源文件> --max-size 4 --output <输出路径>

# 快速模式（直跳ultra）
python file_compressor.py compress --input <源文件> --type PS --output <输出路径> --quick

# 查看所有材料类型的限制
python file_compressor.py list-limits
```

**执行位置**：从项目根目录运行，`file_compressor.py` 位于 `{{PONOS_SKILLS}}/_common/`。

### 3. 输出报告
压缩完成后汇报：
- 原始体积 / 压缩后体积 / 压缩率
- 使用的方法（light/medium/deep/extreme/ultra_color_dpiXX）
- 是否达标
- 如有签名/印章/颜色是否保留

---

## 材料类型 → 大小限制

| 类型 | 限制 | 代码 |
|---|---|---|
| IP证明材料 | ≤2MB | IP |
| RD证明材料 | ≤2MB | RD |
| PS证明材料 | ≤4MB | PS |
| 科技成果转化 | ≤2MB | ACHIEVEMENT |
| 国标/行标 | ≤2MB | STANDARD |
| 营业执照 | ≤500KB | LICENSE |
| 申报书封皮 | ≤1MB | COVER |
| 财务审计报告 | ≤100MB | AUDIT_FINANCIAL |
| 所得税纳税申报表 | ≤5MB | TAX |
| 研发费用专审 | ≤100MB | AUDIT_RD |
| 高新收入专审 | ≤100MB | AUDIT_PS |
| 研发管理制度 | ≤20MB | MANAGEMENT |
| 研发机构及产学研 | ≤20MB | INSTITUTION |
| 成果转化激励制度 | ≤5MB | INCENTIVE |
| 科技人员培养制度 | ≤5MB | TRAINING |
| 人力资源情况 | ≤8MB | HR |
| 销售合同与发票 | ≤20MB | CONTRACT |
| 企业承诺书 | ≤1MB | PROMISE |
| 申请书签字盖章 | ≤50MB | APPLICATION |

---

## 压缩策略（v2.1）

```
light → medium → deep → [有效性检测] → extreme → ultra(彩色优先)
                                         ↓ deep<5%跳过
```

### 各阶段详解

| 阶段 | 方法 | 适用场景 |
|---|---|---|
| light | 垃圾回收+deflate | 文本型PDF小幅压缩 |
| medium | +clean内容流 | 文本型PDF中等压缩 |
| deep | +deflate图片/字体 | 含嵌入字体PDF |
| extreme | +图片重压缩(JPEG2000→JPEG) | 图片型PDF（需deep有效） |
| ultra_color | DPI栅格化+JPEG(chroma4:2:0) | 扫描件/大体积PDF，彩色优先 |
| ultra_gray | DPI栅格化+灰度+JPEG | 彩色超标时降灰度 |

### 关键机制

- **压缩有效性检测**：deep压缩比<5%自动跳过extreme（扫描件特征）
- **自适应DPI**：`DPI ≈ sqrt(目标/原始) × 300`，200→50共18级
- **彩色优先**：先扫描全DPI找最高不超标彩色，全线超标再降灰度
- 图片压缩：尺寸缩减 → 质量递减 → PNG量化256色 → WebP转换 → chroma子采样4:2:0

### 实测基准

| 输入 | 方法 | 输出 | 备注 |
|---|---|---|---|
| PS01(18.17MB/65页/158图) | ultra_color_dpi95 | 3.84MB | 彩色，签章保留 |
| 同上 | ultra_color_dpi90 | 3.48MB | 彩色 |
| 同上 | ultra_gray_dpi100 | 3.91MB | 灰度备用 |

---

## 注意事项

1. **源文件备份**：压缩前自动检查备份（`_backup/`目录），已存在则跳过
2. **输出目录**：建议输出到 `_test/` 或 `_compressed/` 子目录，不覆盖源文件
3. **多次压缩**：压缩是不可逆的，如需重新压缩请从备份恢复源文件
4. **签章印章**：彩色模式保留红色/蓝色印章，灰度模式印章变为黑白但可辨
5. **文本层丢失**：ultra模式将页面渲染为图片重建PDF，原始文本层会丢失（不影响申报系统查看）

---

### 最终步前：同步进度（v1.0.0新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-file-compressor" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


---

## 依赖

- Python 3.8+
- PyMuPDF (fitz): `pip install PyMuPDF`
- Pillow: `pip install Pillow`
