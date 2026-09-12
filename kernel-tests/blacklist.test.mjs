// 硬黑名单（kernel/blacklist.mjs）——灾难级命令的绝对底线
// ---------------------------------------------------------------------------
// 语义：命中即"任何审批档位下都必须弹窗确认"（含 bypass）。因此本测试两个方向都要钉：
//   ① 五族灾难命令（含 sudo/bash -c/管道/复合命令等常见包装与写法）必须命中；
//   ② 近似但正常的命令**不得**命中——误伤会让日常操作被迫弹窗（`grep shutdown log`、
//      `npm run format`、`rm -rf node_modules` 是最容易踩的三类）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesCatastrophic, CATASTROPHIC_FAMILIES } from '../kernel/blacklist.mjs'

const HITS = [
  // ① 根/家目录递归删
  'rm -rf /', 'rm -rf /*', 'rm -fr /', 'rm --recursive --force /', 'rm -r -f /',
  'sudo rm -rf /', 'sudo -n rm -rf /', 'cd /tmp && rm -rf /', 'ls | rm -rf /',
  'bash -c "rm -rf /"', 'sh -c \'rm -rf /\'', 'sudo bash -c "rm -rf /"',
  'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*', 'rm -rf $HOME', 'rm -rf "${HOME}"', 'rm -rf $HOME/*',
  'rd /s /q C:\\', 'rmdir /s /q D:\\', 'del /f /s /q C:\\*', 'Remove-Item -Recurse -Force C:\\',
  // ② mkfs
  'mkfs.ext4 /dev/sda1', 'mkfs -t ext4 /dev/sdb', 'sudo mkfs.xfs /dev/nvme0n1',
  // ③ 格式化 / 分区
  'format C:', 'format.com D:', 'diskpart', 'sudo fdisk /dev/sda', 'parted /dev/sdb',
  // ④ dd 写裸设备
  'dd if=/dev/zero of=/dev/sda bs=1M', 'dd of=/dev/nvme0n1 if=/dev/zero',
  'dd if=x of=\\\\.\\PhysicalDrive0', 'sudo dd if=/dev/urandom of=/dev/sdb',
  // ⑤ 关机 / 重启
  'shutdown -h now', 'shutdown /s /t 0', 'sudo reboot', 'poweroff', 'halt',
  'systemctl reboot', 'systemctl poweroff', 'Stop-Computer -Force', 'Restart-Computer', 'init 0',
]

const MISSES = [
  // 正常删除：子路径 / 相对路径 / 项目目录
  'rm -rf /tmp/x', 'rm -rf ~/proj', 'rm -rf ~/proj/', 'rm -rf ./build', 'rm -rf node_modules',
  'rm -rf dist && npm run build', 'rm file.txt', 'rm -f package-lock.json', 'rm -rf ./.cache',
  'rm -rf $HOME/work/x', 'rm -rf C:\\Users\\me\\tmp', 'del /s C:\\Users\\me\\tmp\\*',
  // format 作为参数 / 子命令（最易误伤）
  'npm run format', 'git format-patch -1', 'prettier --write --format x', 'cargo fmt -- --check',
  // shutdown/reboot 只出现在参数或文件内容里
  'grep shutdown app.log', 'echo reboot later', 'cat diskpart.md', 'rg -n "poweroff" docs/',
  'git log --grep=reboot',
  // dd 写普通文件
  'dd if=/dev/sda of=backup.img', 'dd if=/dev/zero of=./zeros.bin bs=1M count=10',
  // 其他正常命令
  'df -h', 'ls /', 'git clean -fd', 'git push --force origin main', 'drop table users',
  'bash -c "npm run format"', 'sh -c "rm -rf node_modules"', 'clear',
]

test('硬黑名单：五族灾难命令必须命中', () => {
  for (const cmd of HITS) assert.equal(matchesCatastrophic(cmd), true, `应命中：${cmd}`)
})

test('硬黑名单：近似但正常的命令不得命中（误伤会迫使用户频繁确认）', () => {
  for (const cmd of MISSES) assert.equal(matchesCatastrophic(cmd), false, `不应命中：${cmd}`)
})

test('硬黑名单：非字符串/空输入安全返回 false', () => {
  for (const v of [null, undefined, '', '   ', 0, 42, {}, []]) assert.equal(matchesCatastrophic(v), false, `不应命中：${String(v)}`)
})

test('硬黑名单：灾难族清单与文档引用保持稳定', () => {
  assert.equal(CATASTROPHIC_FAMILIES.length, 5)
  assert.ok(CATASTROPHIC_FAMILIES.includes('root-or-home-recursive-delete'))
  assert.ok(CATASTROPHIC_FAMILIES.includes('power-control'))
})
