# yfljsj CLI 字段级增强设计（2026-09-01）

> 承接 `2026-09-01-yfljsj-cli-design.md`（CLI 全量封装）。本文档针对用户实测反馈的两个痛点做增强：
> ① 使用 CLI 时仍需下载前端 chunk 逆向字段（命令表仅 20% 有参数、核心写命令 params 为空）
> ② 缺少逻辑关联说明和使用规范，模型需重复尝试才能顺利操作

## 1. 背景与问题

### 1.1 现状诊断（2026-09-01 实测确认）

| 痛点 | 根因 | 实证 |
|---|---|---|
| 模型需下载 chunk | 命令表 535 命令仅 106 个（20%）有参数定义，且全是分页 current/size | `node -e` 统计 |
| 核心写命令字段未知 | projectInfo-add / projectAppro-add / rdItem-add 的 params 均为 `{}` | 命令表检查 |
| 关联关系不明 | 项目/立项/研发活动三者层级不清，模型建错对象 | 实测：先建 projectInfo 而非 rdItem/approval |
| 字段来源/枚举未知 | headPersonId 从 getUserList 的 id 拿、techEconTarget 是数字枚举 1/3、planFile 必填无文件可传占位 | 实测踩坑 |
| 必填字段靠试错 | 发空请求读报错猜字段 | verify 报告 129 个接口报错含字段 |

### 1.2 增强目标

1. **全量字段探测**：535 接口全部标注字段（类型/必填/描述/枚举/来源），含读接口
2. **逻辑关联图谱**：业务对象层级与关联字段（项目→立项/研发活动/费用/人员/IP/产品/收入）
3. **完整操作手册**：每个业务对象的操作序列（先建什么→再建什么→字段从哪来），含示例命令
4. **新子命令**：`schema`（字段定义）、`relations`（关联图谱）、`explore`（交互探测）、`doc`（操作手册）
5. **模型畅通**：模型一条 `schema` 命令拿到全部字段信息，免重复试错

## 2. 数据模型

### 2.1 命令表字段升级（apis.json）

```json
{
  "version": 2,
  "services": { "oauth": "...", "upms": "...", "rcms": "..." },
  "modules": {
    "workbench": {
      "title": "工作台",
      "service": "rcms",
      "commands": [
        {
          "action": "projectAppro-add",
          "method": "POST",
          "path": "/workbench/projectAppro/add",
          "kind": "write",
          "desc": "创建项目立项信息",
          "params": {
            "tenantId": { "type": "number", "required": true, "auto": true, "desc": "租户ID（自动注入）" },
            "projectId": { "type": "number", "required": true, "desc": "项目ID（projectInfo 的 id）", "source": "projectInfo-list" },
            "headPerson": { "type": "string", "required": true, "desc": "项目负责人姓名", "source": "user/sysUser/getUserList.username" },
            "headPersonId": { "type": "number", "required": true, "desc": "负责人ID（注意是 getUserList 的 id 非 userId）", "source": "user/sysUser/getUserList.id" },
            "techEconTarget": { "type": "number", "required": true, "desc": "主要技术经济目标", "enum": [1, 3] },
            "researchContent": { "type": "string", "required": true, "desc": "研究内容" },
            "expectTarget": { "type": "string", "required": true, "desc": "项目预期目标" },
            "orgImplementMode": { "type": "string", "required": true, "desc": "组织实施方式" },
            "coreTechInnovation": { "type": "string", "required": true, "desc": "核心技术及创新点" },
            "planFile": { "type": "string", "required": true, "desc": "计划任务书路径（无文件可传占位）" },
            "planFileName": { "type": "string", "required": false, "desc": "计划任务书文件名" },
            "resolveFile": { "type": "string", "required": true, "desc": "立项决议书路径（无文件可传占位）" },
            "resolveFileName": { "type": "string", "required": false, "desc": "立项决议书文件名" }
          }
        }
      ]
    }
  },
  "relations": {
    "project": {
      "title": "项目",
      "createOrder": ["projectInfo-add", "projectAppro-add", "rdItem-add"],
      "children": {
        "approval": { "title": "立项信息", "via": "projectId → project.id", "api": "projectAppro" },
        "rdItem": { "title": "研发活动", "via": "sourceProjectId → project.id", "api": "rdItem" },
        "member": { "title": "项目成员", "via": "projectId → project.id", "api": "projectMember" },
        "equipment": { "title": "设备", "via": "projectId → project.id", "api": "projectEquip" },
        "budget": { "title": "预算", "via": "projectId → project.id", "api": "projectRdCost" }
      }
    }
  },
  "operations": {
    "createProject": {
      "title": "创建研发项目（含立项）",
      "steps": [
        { "cmd": "workbench projectInfo-add", "desc": "1. 建项目基础信息（projectName/projectCode）" },
        { "cmd": "workbench projectAppro-add", "desc": "2. 建立项信息（负责人从 getUserList 选）" },
        { "cmd": "enterprise rdItem-add", "desc": "3. 建研发活动（sourceProjectId=项目id）" }
      ],
      "examples": [
        "yfljsj workbench projectInfo-add --data '{\"projectName\":\"...\",\"projectCode\":\"...\"}'",
        "yfljsj workbench projectAppro-add --data '{\"projectId\":100216,\"headPersonId\":100131,...}'"
      ]
    }
  }
}
```

### 2.2 字段来源类型

| source 类型 | 含义 | 示例 |
|---|---|---|
| `list:<cmd>` | 从某列表命令取 id | `source: "projectInfo-list"` |
| `api:<path>` | 从某接口取字段 | `source: "user/sysUser/getUserList.id"` |
| `enum:[...]` | 枚举值 | `enum: [1, 3]` |
| `auto` | 自动注入（tenantId） | `auto: true` |
| `computed` | 系统计算字段（勿传） | realTotalBudget |

## 3. 新子命令

### 3.1 `yfljsj schema <module> <action>`
查看命令的完整字段定义（类型/必填/描述/枚举/来源），模型一条命令拿全信息。
```
$ yfljsj schema workbench projectAppro-add
命令: projectAppro-add (POST /workbench/projectAppro/add) [write]
字段:
  tenantId        number  必填  自动注入: 租户ID
  projectId       number  必填  项目ID ← projectInfo-list.id
  headPerson      string  必填  负责人姓名 ← getUserList.username
  headPersonId    number  必填  负责人ID ← getUserList.id (注意非 userId!)
  techEconTarget  number  必填  主要技术经济目标 = 1|3
  ...
关联: 需先 projectInfo-add → 建项目
```

### 3.2 `yfljsj relations [object]`
输出业务对象关联图谱（无参=全图谱，有参=单对象）。
```
$ yfljsj relations project
项目 (workbench/projectInfo)
 ├─ 立项信息 (projectAppro)   via projectId → project.id
 ├─ 研发活动 (rdItem)         via sourceProjectId → project.id
 ├─ 项目成员 (projectMember)  via projectId → project.id
 ├─ 设备 (projectEquip)       via projectId → project.id
 └─ 预算 (projectRdCost)      via projectId → project.id
创建顺序: projectInfo-add → projectAppro-add → rdItem-add
```

### 3.3 `yfljsj explore <path> [--method POST] [--service rcms]`
交互式字段探测：发空请求读报错 → 解析必填字段 → 补字段重试 → 沉淀进命令表。
```
$ yfljsj explore /workbench/projectAppro/add
探测 /workbench/projectAppro/add (POST rcms)
  空请求 → [projectId:must not be null, headPerson:must not be null]
  补 projectId → [headPerson:must not be null, ...]
  ...
  已探明字段: projectId(number,必填), headPerson(string,必填), ...
  已写入命令表 (或 --dry-run 仅预览)
```

### 3.4 `yfljsj doc [object]`
输出完整操作手册（无参=目录，有参=单对象全流程）。
```
$ yfljsj doc createProject
创建研发项目（含立项）
  步骤:
  1. workbench projectInfo-add  ← 建项目基础信息
     yfljsj workbench projectInfo-add --data '{"projectName":"AI...","projectCode":"TEST-RD-..."}'
  2. workbench projectAppro-add  ← 建立项信息
     负责人: yfljsj upms user sysUser-getUserList 查询 → 取 id
     ...
```

## 4. 字段探测策略

### 4.1 自动探测（explore 核心）

| 策略 | 适用 | 说明 |
|---|---|---|
| 空请求报错解析 | 全部 | 发 `{}` 请求读 `[xxx:must not be null]`，提取必填字段 |
| 补字段迭代 | 全部 | 逐个补上已探明字段再探测，挖出后续必填 |
| 已有数据参考 | 读接口 | 从列表/详情接口返回的数据提取字段名与类型 |
| 前端 chunk 逆向 | 复杂表单 | 下载含表单的 chunk，从 be 对象/选择器提取字段与枚举 |
| 人工沉淀 | 踩坑经验 | 已确认的字段来源/枚举/占位规则写死进 seed |

### 4.2 优先级（保证核心链路优先完善）

1. **高企申报核心链路**（项目/立项/研发活动/费用/人员/IP/产品/收入）——业务价值最高，全字段标注 + 操作手册
2. 其余写接口——自动探测必填字段
3. 读接口——从返回数据提取字段 + 分页参数

## 5. 测试

- `schema` 输出正确性（字段定义完整、来源/枚举渲染）
- `relations` 图谱结构（父子关系、创建顺序）
- `explore` 探测流程（mock 网关报错 → 字段提取 → 命令表写入）
- `doc` 手册输出（步骤/示例命令）
- 命令表 v1→v2 迁移（旧 apis.json 无损升级）
- 全量回归（既有 119 测试）

## 6. 验收标准

1. `yfljsj schema <cmd>` 对核心写命令输出完整字段（类型/必填/枚举/来源），模型免试错
2. `yfljsj relations` 输出业务对象关联图谱与创建顺序
3. `yfljsj explore` 可交互探测未知接口并沉淀字段
4. `yfljsj doc` 输出操作手册（步骤+示例）
5. 命令表 v2 含全部 535 接口的字段定义（探测到的必填字段全覆盖）
6. 全量测试通过
