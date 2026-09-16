"""office 脚本共享基础件：版本口径与内容指纹归一化的**单一真相源**。

为什么单独成文件：`docx_edit.py`（块 id）与 `sheet_edit.py`（行/列 id）都要用**同一条**
归一化规则来算内容指纹。若各写一份，两边规则会各自漂移 —— 而协同系统里"两边判等口径
不一致"会直接表现为"同一处改动被一方判成新、另一方判成旧"，属最难定位的一类故障
（不报错、只是合并结果悄悄不对）。

为什么不做成包/安装：这两个脚本是**被单独 spawn 的入口**（bridge 侧 `runOfficeScript`）。
python 会把脚本所在目录放进 `sys.path`，所以同级 `from office_common import …` 直接可用，
不需要装包、不需要 PYTHONPATH。
"""

import hashlib
import re

_WS = re.compile(r"\s+")


def file_sha256(path):
    """整文件内容哈希 —— S1 阶段 `baseVersion` 的来源。

    为什么用整文件而不是"规范化内容哈希"：S1 无版本链，而这里要防的是**丢失更新** ——
    任何人（外部 Word/Excel/网盘同步/另一个客户端）动过文件，就应该让本次提交失败并让用户
    重新载入。整文件哈希对"文件被动过"最敏感：宁可多让用户重载一次，也不要用宽容的口径
    把别人的改动覆盖掉。（S3/S4 阶段换来源为版本链 versionId，字段名与语义不变。）
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def norm_text(text):
    """归一化文本：连续空白折成一个空格、去首尾。

    **不动**大小写、标点、全/半角 —— 那些是内容差异，抹掉会把不同的东西判成同一个。
    """
    return _WS.sub(" ", text or "").strip()


def digest12(kind, payload):
    """内容指纹前 12 位（kind 参与哈希，避免"同文本的段落与表格行"撞车）。"""
    return hashlib.sha256(f"{kind}\x00{payload}".encode("utf-8")).hexdigest()[:12]


def content_id(kind, payload, occurrence):
    """id = 内容指纹 + 出现序号。

    * 幂等/稳定：id 只由**内容**决定，不掺位置、不掺时间、不掺 XML 修订噪声
      （Word 重存会改 `rsid`/`w:proofErr`，若掺进去，重存一次整篇 id 全变）。
    * 消歧：文档里有两段一模一样的文字时纯内容哈希必然撞车，故追加出现序号。
      代价：在别处插入同内容块会让后续同名块序号漂移（已知限制，登记终验）。
    """
    return f"{digest12(kind, payload)}:{occurrence}"


def assign_ids(kind, payloads):
    """把一串载荷转成 id 序列（同内容靠出现序号区分）。"""
    seen = {}
    out = []
    for p in payloads:
        n = seen.get(p, 0) + 1
        seen[p] = n
        out.append(content_id(kind, p, n))
    return out
