// 高风险命令匹配验证（TDD，见 docs/superpowers/plans/2026-08-14-plan-execute-mode.md Task 2）
import { matchesHighRisk } from '../server/highrisk.mjs'

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// 命中：文件/目录删除与移动
check(matchesHighRisk('rm -rf node_modules'), 'rm -rf 命中')
check(matchesHighRisk('rm -f important.txt'), 'rm -f 命中')
check(matchesHighRisk('rm old_backup.zip'), 'rm 后跟路径命中')
check(matchesHighRisk('del /s /q temp\\*.log'), 'del 命中')
check(matchesHighRisk('erase C:\\data\\file.txt'), 'erase 命中')
check(matchesHighRisk('rmdir /s /q old_dir'), 'rmdir 命中')
check(matchesHighRisk('rd /s /q build'), 'rd /s 命中')
check(matchesHighRisk('move a.txt b.txt'), 'move 命中')
check(matchesHighRisk('mv src dst'), 'mv 命中')

// 命中：git 破坏性
check(matchesHighRisk('git reset --hard HEAD'), 'git reset --hard 命中')
check(matchesHighRisk('git push --force origin main'), 'git push --force 命中')
check(matchesHighRisk('git clean -fd'), 'git clean -f 命中')
check(matchesHighRisk('git checkout -- src/'), 'git checkout -- 命中')
check(matchesHighRisk('git stash drop'), 'git stash drop 命中')
check(matchesHighRisk('git branch -D feature'), 'git branch -D 命中')
check(matchesHighRisk('git commit --amend'), 'git commit --amend 命中')

// 命中：进程/系统
check(matchesHighRisk('taskkill /f /im node.exe'), 'taskkill 命中')
check(matchesHighRisk('kill -9 1234'), 'kill 命中')
check(matchesHighRisk('Stop-Process -Name notepad'), 'Stop-Process 命中')
check(matchesHighRisk('format d:'), 'format 命中')
check(matchesHighRisk('diskpart'), 'diskpart 命中')
check(matchesHighRisk('reg delete HKCU\\Software\\x'), 'reg delete 命中')

// 命中：数据库/基础设施
check(matchesHighRisk('DROP TABLE users'), 'DROP TABLE 命中')
check(matchesHighRisk('DELETE FROM logs WHERE 1=1'), 'DELETE FROM 命中')
check(matchesHighRisk('kubectl delete pod nginx'), 'kubectl delete 命中')
check(matchesHighRisk('terraform destroy'), 'terraform destroy 命中')

// 不命中：普通命令
check(!matchesHighRisk('ls -la'), 'ls 不命中')
check(!matchesHighRisk('npm install'), 'npm install 不命中')
check(!matchesHighRisk('git status'), 'git status 不命中')
check(!matchesHighRisk('cat README.md'), 'cat 不命中')
check(!matchesHighRisk('node --version'), 'node --version 不命中')
check(!matchesHighRisk(''), '空命令不命中')
check(!matchesHighRisk(null), 'null 不命中')
check(!matchesHighRisk('"git log --oneline -3"'), '引号包裹的普通 git 命令不命中')

// 大小写与引号容错
check(matchesHighRisk('RM -RF build'), '大写 RM 命中')
check(matchesHighRisk('"git reset --hard HEAD"'), '引号包裹的 git reset 命中')

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
