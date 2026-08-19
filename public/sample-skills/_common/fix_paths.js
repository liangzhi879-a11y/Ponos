const fs = require('fs');
const path = require('path');

const files = [
  'gxtz-info-collector.md', 'gxtz-management-materials.md', 'gxtz-audit-verification.md',
  'gxtz-invoice-ps-matching.md', 'gxtz-contract-review.md', 'gxtz-wecom-collector.md',
  'gxtz-submission-packager.md'
];

const baseDir = 'C:/Users/T203-15/Desktop/2023guogao/{{YFW_SKILLS}}';

for (const f of files) {
  const fp = path.join(baseDir, f);
  let content = fs.readFileSync(fp, 'utf-8');

  // Replace any remaining backslash path separators with forward slashes
  // A backslash that is:
  // - NOT at end of line (not a line continuation)
  // - NOT preceded by space (not a line continuation)
  // Should be converted to forward slash
  // Strategy: convert all \ to /, then restore line continuations
  // Line continuations have pattern: " \" + newline

  // Step 1: Temporarily mark line continuations
  content = content.replace(/ \\\n/g, ' __LINE_CONT__\n');
  content = content.replace(/ \\\r\n/g, ' __LINE_CONT__\n');

  // Step 2: Convert all remaining \ to /
  content = content.replace(/\\/g, '/');

  // Step 3: Restore line continuations
  content = content.replace(/__LINE_CONT__\n/g, ' \\\n');

  fs.writeFileSync(fp, content, 'utf-8');
  console.log('Fixed paths in ' + f);
}
