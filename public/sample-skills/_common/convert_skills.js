const fs = require('fs');
const path = require('path');

const SRC_BASE = "C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills";
const DST_BASE = "C:/Users/T203-15/Desktop/2023guogao/{{YFW_SKILLS}}";

const SKILLS = [
  {
    dir: "gxtz-info-collector",
    file: "gxtz-info-collector.md",
    triggers: ["高新认定","高企认定","高新技术企业","信息收集","资料清单","企业信息调查","资料收集","材料清单"]
  },
  {
    dir: "gxtz-management-materials",
    file: "gxtz-management-materials.md",
    triggers: ["管理制度","研发制度","研发机构","产学研合作","成果转化激励","研发辅助账","研发费用台账"]
  },
  {
    dir: "gxtz-audit-verification",
    file: "gxtz-audit-verification.md",
    triggers: ["专审报告核对","审计核对","研发费用专审","高新收入专审","审计报告核对","专审核对"]
  },
  {
    dir: "gxtz-invoice-ps-matching",
    file: "gxtz-invoice-ps-matching.md",
    triggers: ["发票PS筛选","PS匹配","全量发票","高新收入发票","发票匹配","PS发票"]
  },
  {
    dir: "gxtz-contract-review",
    file: "gxtz-contract-review.md",
    triggers: ["技术合同审查","合同评估","合同合规","技术开发合同","技术转让合同","合同认定登记","合同审查"]
  },
  {
    dir: "gxtz-wecom-collector",
    file: "gxtz-wecom-collector.md",
    triggers: ["企微","企业微信","wecom","企业微信会话","企微附件","企微文件","客户沟通记录","企业微信资料"]
  },
  {
    dir: "gxtz-submission-packager",
    file: "gxtz-submission-packager.md",
    triggers: ["打包","申报打包","材料打包","上传准备","提交材料","最终版本","申报包","提交系统","申报系统要求"]
  }
];

const PATH_REPLACEMENTS = [
  [/C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\/g, "{{YFW_SKILLS}}/_common/"],
  [/C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\/g, "{{YFW_SKILLS}}/"],
  [/C:\\Users\\T203-15\\.trae-cn\\skills\\/g, "{{YFW_SKILLS}}/"],
  [/\.trae\/skills\/_common\//g, "{{YFW_SKILLS}}/_common/"],
  [/\.trae\/skills\//g, "{{YFW_SKILLS}}/"],
  [/\.trae\//g, ".claude/"],
  [/RunCommand/g, "Bash"],
  [/TRAE agent/g, "Claude Code agent"],
  [/（由 TRAE agent 完成）/g, "（由 agent 完成）"],
];

function applyReplacements(content) {
  for (const [pattern, replacement] of PATH_REPLACEMENTS) {
    content = content.replace(pattern, replacement);
  }
  // Fix any double slashes that might result
  content = content.replace(/\.claude\/\//g, ".claude/");
  return content;
}

function fixFrontmatter(content, triggers) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return content;

  // Find end of frontmatter
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return content;

  // Check if triggers already exist
  const fmLines = lines.slice(1, endIdx);
  const hasTriggers = fmLines.some(l => l.trim().startsWith('triggers:'));

  if (!hasTriggers) {
    const triggerYaml = "triggers:\n" + triggers.map(t => `  - "${t}"`).join('\n');
    const newLines = [...lines.slice(0, endIdx), triggerYaml, ...lines.slice(endIdx)];
    content = newLines.join('\n');
  }

  return content;
}

function convertSkill(skillDir, destFile, triggers) {
  const srcPath = path.join(SRC_BASE, skillDir, "SKILL.md");
  const destPath = path.join(DST_BASE, destFile);

  if (!fs.existsSync(srcPath)) {
    console.error(`ERROR: Source not found: ${srcPath}`);
    return;
  }

  let content = fs.readFileSync(srcPath, 'utf-8');

  // Apply path replacements
  content = applyReplacements(content);

  // Fix frontmatter
  content = fixFrontmatter(content, triggers);

  // Write destination
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, 'utf-8');

  const lineCount = content.split('\n').length;
  console.log(`Converted: ${srcPath} -> ${destPath} (${lineCount} lines)`);
}

// Main
fs.mkdirSync(DST_BASE, { recursive: true });
for (const skill of SKILLS) {
  convertSkill(skill.dir, skill.file, skill.triggers);
}
console.log("Done!");
