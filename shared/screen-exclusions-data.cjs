'use strict'
/**
 * `Screen` 工具的**缺省排除清单数据**（真源；P2 computeruse 像素层，P2a；spec §3.5 S4）。
 *
 * 为什么数据单独放 shared/ 且是 CJS：`electron/main.cjs`（CJS）需要它把清单传给执行器，
 * 而它**不能 require `.mjs`**。若在 main.cjs 里另抄一份 ⇒ 必然漂移。
 * 同 `shared/app-control-commands.cjs`（CJS + ESM 转发层）先例。
 *
 * 收录判据：① 凭证类（密码管理器、U 盾、支付）；② 通讯类（私聊窗口含大量非工作内容）。
 * **本清单是 fail-closed 的起点，不是完备集合** —— 后续可在设置里追加。
 *
 * 进程名一律**小写、不带 .exe**（匹配时归一化，见 kernel/screen-exclusions.mjs）。
 */
const DEFAULT_EXCLUSIONS = {
  processes: [
    // 凭证类
    'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane',
    'enpass', 'roboform', 'nordpass',
    // 通讯类（私聊窗口含非工作内容）
    'weixin', 'wxwork', 'qq', 'dingtalk', 'telegram', 'whatsapp', 'signal', 'discord',
    // 支付/证书类
    'alipay', 'bankassist',
  ],
  titlePatterns: [
    // 中文凭证/支付/证书关键词（标题里几乎必然出现）
    '*密码*', '*支付*', '*转账*', '*U盾*', '*U 盾*', '*证书管理*', '*银行卡*',
    // 英文
    '*password*', '*credential*', '*wallet*', '*1password*',
  ],
}

module.exports = { DEFAULT_EXCLUSIONS }
