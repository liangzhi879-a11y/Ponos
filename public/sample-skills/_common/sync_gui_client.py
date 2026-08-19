"""
sync_gui_client.py - 技能同步可视化工具 [客户端] v1.0.0

功能（只读）：
  GitHub → C盘仓库  检查并拉取最新技能更新
  查看所有技能版本列表
  不支持推送操作（需使用开发版 sync_gui.py）

用法：
  python sync_gui_client.py
"""

import os
import sys
import re
import json
import threading
import subprocess
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
from pathlib import Path
from datetime import datetime

SKILLS_ROOT = Path(__file__).resolve().parent.parent
GIT_DIR = SKILLS_ROOT / ".git"
VERSION_FILE = SKILLS_ROOT / ".version_state.json"
CREATIONFLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
REMOTES = ["origin", "origin-ssh"]
SSH_ENV = os.environ.copy()
SSH_ENV["GIT_SSH_COMMAND"] = "ssh -i C:/Users/T203-15/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"


def run_git(args, timeout=60):
    try:
        result = subprocess.run(
            ["git"] + args, cwd=str(SKILLS_ROOT),
            capture_output=True, text=True, timeout=timeout,
            creationflags=CREATIONFLAGS, env=SSH_ENV)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "Git timed out"
    except FileNotFoundError:
        return -1, "", "Git not found"


def run_git_streaming(args, timeout=120):
    try:
        proc = subprocess.Popen(
            ["git"] + args, cwd=str(SKILLS_ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, creationflags=CREATIONFLAGS, env=SSH_ENV)
        start = datetime.now()
        for line in proc.stdout:
            if (datetime.now() - start).seconds > timeout:
                proc.kill()
                yield "[超时] 操作已终止"
                break
            yield line.rstrip()
        proc.wait()
    except FileNotFoundError:
        yield "[错误] 未找到 git 命令"
    except Exception as e:
        yield "[错误] {}".format(str(e))


def git_fetch(timeout=90):
    for remote in REMOTES:
        code, _, _ = run_git(["fetch", remote], timeout=timeout)
        if code == 0:
            return remote, True, ""
    return "", False, "SSH/HTTPS 均无法连接 GitHub"


def git_pull(branch, timeout=120):
    for remote in REMOTES:
        code2, _, _ = run_git(["pull", "--ff-only", remote, branch], timeout=timeout)
        if code2 == 0:
            return True
    return False


def extract_version(skill_dir):
    md = SKILLS_ROOT / skill_dir / "SKILL.md"
    if not md.exists():
        return "?"
    try:
        m = re.search(r'version:\s*"([\d.]+)"', md.read_text(encoding="utf-8"))
        return m.group(1) if m else "?"
    except Exception:
        return "?"


class ClientGUI:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("GXTZ 技能同步 [客户端]")
        self.root.geometry("800x600")
        self.root.minsize(700, 520)

        self._setup_style()
        self._build_ui()
        self.root.after(200, self._async_refresh_status)
        self.root.mainloop()

    def _setup_style(self):
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.c = {
            "bg": "#f5f5f5", "fg": "#1a1a1a", "accent": "#2563eb",
            "success": "#16a34a", "warning": "#f59e0b", "danger": "#dc2626",
            "card": "#ffffff", "border": "#e5e7eb", "dim": "#6b7280",
        }
        self.root.configure(bg=self.c["bg"])
        self.style.configure("TFrame", background=self.c["bg"])
        self.style.configure("TLabelframe", background=self.c["bg"], borderwidth=1, relief="solid")
        self.style.configure("TLabelframe.Label", background=self.c["bg"], foreground=self.c["fg"],
                              font=("Microsoft YaHei UI", 10, "bold"))

    def _build_ui(self):
        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True, padx=0, pady=0)

        h = ttk.Frame(main)
        h.pack(fill="x", padx=16, pady=(12, 8))
        t = ttk.Frame(h); t.pack(side="left")
        ttk.Label(t, text="技能同步工具", font=("Microsoft YaHei UI", 16, "bold")).pack(anchor="w")
        ttk.Label(t, text="客户端 - 只读拉取  |  不支持推送", foreground=self.c["dim"],
                   font=("Microsoft YaHei UI", 9)).pack(anchor="w")
        self.status_dot = tk.Label(h, text="● 正在连接...", fg=self.c["warning"],
                                    bg=self.c["bg"], font=("Microsoft YaHei UI", 9, "bold"))
        self.status_dot.pack(side="right")

        content = ttk.Frame(main)
        content.pack(fill="both", expand=True, padx=16, pady=(4, 8))
        content.columnconfigure(0, weight=3)
        content.columnconfigure(1, weight=2)
        content.rowconfigure(0, weight=1)

        left = ttk.Frame(content)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        right = ttk.Frame(content)
        right.grid(row=0, column=1, sticky="nsew")
        right.rowconfigure(0, weight=1)

        gf = ttk.Frame(left)
        gf.pack(fill="x", pady=(0, 8))
        r1 = ttk.Frame(gf); r1.pack(fill="x", pady=(0, 2))
        ttk.Label(r1, text="本地 HEAD", font=("Microsoft YaHei UI", 8),
                  foreground=self.c["dim"]).pack(side="left")
        ttk.Label(r1, text="远程 HEAD", font=("Microsoft YaHei UI", 8),
                  foreground=self.c["dim"]).pack(side="right")
        r2 = ttk.Frame(gf); r2.pack(fill="x")
        self.lbl_local = ttk.Label(r2, text="...", font=("Consolas", 9))
        self.lbl_local.pack(side="left")
        self.lbl_remote = ttk.Label(r2, text="...", font=("Consolas", 9))
        self.lbl_remote.pack(side="right")
        a = ttk.Frame(gf); a.pack(fill="x", pady=(2, 0))
        self.lbl_arrow = ttk.Label(a, text="", font=("Microsoft YaHei UI", 9, "bold"))
        self.lbl_arrow.pack(anchor="center")

        lf = ttk.Labelframe(left, text="技能版本列表", padding=(8, 4))
        lf.pack(fill="both", expand=True)
        cols = ("skill", "version", "status")
        self.tree = ttk.Treeview(lf, columns=cols, show="headings", height=14, selectmode="none")
        self.tree.heading("skill", text="技能名称", anchor="w")
        self.tree.heading("version", text="版本", anchor="center")
        self.tree.heading("status", text="状态", anchor="center")
        self.tree.column("skill", width=200, minwidth=140)
        self.tree.column("version", width=80, minwidth=60, anchor="center")
        self.tree.column("status", width=80, minwidth=70, anchor="center")
        self.tree.tag_configure("behind", foreground=self.c["danger"])
        self.tree.tag_configure("ok", foreground=self.c["dim"])
        self.tree.tag_configure("updated", foreground=self.c["success"])
        sb = ttk.Scrollbar(lf, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        af = ttk.Labelframe(right, text="同步操作", padding=(12, 8))
        af.pack(fill="both", expand=True)

        bo = {"fill": "x", "pady": 3, "ipady": 2}
        ttk.Label(af, text="GitHub → C盘仓库",
                  font=("Microsoft YaHei UI", 10, "bold")).pack(anchor="w", pady=(0, 8))

        ttk.Button(af, text=" 检查 GitHub 更新 ",
                   command=self._act_check).pack(**bo)
        ttk.Label(af, text="查看是否有新的技能版本",
                  font=("Microsoft YaHei UI", 8), foreground=self.c["dim"]).pack(anchor="w", pady=(0, 6))

        ttk.Button(af, text=" 拉取技能更新 ",
                   command=self._act_pull).pack(**bo)
        ttk.Label(af, text="下载最新技能版本到本地",
                  font=("Microsoft YaHei UI", 8), foreground=self.c["dim"]).pack(anchor="w", pady=(0, 6))

        ttk.Separator(af, orient="horizontal").pack(fill="x", pady=8)

        ttk.Button(af, text=" 刷新状态 ",
                   command=self._async_refresh_status).pack(anchor="center", pady=(4, 0))

        tip = ttk.Labelframe(af, text="提示", padding=(10, 6))
        tip.pack(fill="x", pady=(12, 0))
        tip_text = ("如需推送技能变更，\n请使用开发版同步工具\n"
                    "sync_gui.py")
        ttk.Label(tip, text=tip_text, font=("Microsoft YaHei UI", 8),
                  foreground=self.c["dim"], justify="left").pack(anchor="w")

        ic = ttk.Labelframe(right, text="仓库信息", padding=(10, 6))
        ic.pack(fill="x", pady=(8, 0))
        self.info_repo = ttk.Label(ic, text="仓库: ...", font=("Microsoft YaHei UI", 8),
                                    foreground=self.c["dim"])
        self.info_repo.pack(anchor="w")
        self.info_count = ttk.Label(ic, text="技能: ...", font=("Microsoft YaHei UI", 8),
                                     foreground=self.c["dim"])
        self.info_count.pack(anchor="w")

        logf = ttk.Labelframe(main, text="操作日志", padding=(6, 4))
        logf.pack(fill="both", expand=True, padx=16, pady=(0, 4))
        self.log = scrolledtext.ScrolledText(logf, height=6, wrap="word",
                                              font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4",
                                              borderwidth=0, padx=6, pady=4)
        self.log.pack(fill="both", expand=True)
        self.log.tag_configure("info", foreground="#d4d4d4")
        self.log.tag_configure("ok", foreground="#16a34a")
        self.log.tag_configure("err", foreground="#dc2626")
        self.log.tag_configure("warn", foreground="#f59e0b")
        self.log.tag_configure("dim", foreground="#6b7280")
        self.log.tag_configure("bold", foreground="#ffffff", font=("Consolas", 9, "bold"))
        self.log.tag_configure("hdr", foreground="#60a5fa", font=("Consolas", 10, "bold"))
        self.log.config(state="disabled")
        self._put("  技能同步工具 [客户端] 已启动。\n  连接模式: SSH (origin-ssh) -> HTTPS (origin)\n  仅支持从 GitHub 拉取更新。\n", "dim")

        self.pb = ttk.Progressbar(main, mode="indeterminate", length=200)

    def _put(self, text, tag="info"):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", tag)
        self.log.see("end")
        self.log.config(state="disabled")
        self.root.update_idletasks()

    def _head(self, text):
        self._put("─" * 56, "dim")
        self._put("  " + text, "hdr")
        self._put("─" * 56, "dim")

    def _prog(self, show):
        if show:
            self.pb.pack(fill="x", padx=16, pady=(0, 4))
            self.pb.start(8)
        else:
            self.pb.stop()
            self.pb.pack_forget()
        self.root.update_idletasks()

    def _dot(self, text, key="success"):
        m = {"success": self.c["success"], "warning": self.c["warning"],
             "danger": self.c["danger"], "dim": self.c["dim"]}
        self.status_dot.config(text=text, fg=m.get(key, self.c["dim"]))

    def _thread(self, fn):
        def w():
            try:
                fn()
            except Exception as e:
                self.root.after(0, lambda: self._put("[异常] " + str(e), "err"))
            finally:
                self.root.after(0, lambda: self._prog(False))
        self._prog(True)
        threading.Thread(target=w, daemon=True).start()

    def _async_refresh_status(self):
        self._thread(self._refresh)

    def _refresh(self):
        self.root.after(0, lambda: self._put("正在获取仓库状态...\n", "dim"))
        self.root.after(0, lambda: self._dot("● 检测中...", "dim"))

        code, local, _ = run_git(["rev-parse", "HEAD"])
        local_short = local[:8] if code == 0 else "?"
        self.root.after(0, lambda: self.lbl_local.config(text=local_short))

        remote_name, ok, err = git_fetch(timeout=90)
        if ok:
            self.root.after(0, lambda: self._put("连接成功 ({})".format(remote_name), "ok"))
            _, remote, _ = run_git(["rev-parse", "origin/main"])
            remote_short = remote[:8] if remote else "?"
        else:
            remote_short = "无法连接"
            self.root.after(0, lambda: self._put("[失败] " + err, "err"))

        self.root.after(0, lambda: self.lbl_remote.config(text=remote_short))

        if remote_short == "无法连接":
            self.root.after(0, lambda: self.lbl_arrow.config(
                text="⚠ 无法连接 GitHub", foreground=self.c["warning"]))
            self.root.after(0, lambda: self._dot("⚠ 离线", "warning"))
        else:
            _, local_full, _ = run_git(["rev-parse", "HEAD"])
            behind = False
            if local_full != remote:
                code, _, _ = run_git(["merge-base", "--is-ancestor", local_full, remote])
                behind = code == 0
            if behind:
                self.root.after(0, lambda: self.lbl_arrow.config(
                    text="↓ 有可用更新，请拉取", foreground=self.c["danger"]))
                self.root.after(0, lambda: self._dot("● 有新版本", "danger"))
            else:
                self.root.after(0, lambda: self.lbl_arrow.config(
                    text="✓ 已是最新", foreground=self.c["success"]))
                self.root.after(0, lambda: self._dot("● 已是最新", "success"))

        self.root.after(0, lambda: self.tree.delete(*self.tree.get_children()))
        skill_dirs = sorted([d.name for d in SKILLS_ROOT.iterdir()
                              if d.is_dir() and d.name.startswith("gxtz-")])
        for sd in skill_dirs:
            ver = extract_version(sd)
            self.root.after(0, lambda sd=sd, ver=ver: self.tree.insert(
                "", "end", values=(sd, "v" + ver, "—"), tags=("ok",)))

        self._mark_status()
        self.root.after(0, lambda: self.info_repo.config(text="仓库: " + str(SKILLS_ROOT)))
        self.root.after(0, lambda: self.info_count.config(text="技能: {} 个".format(len(skill_dirs))))
        self.root.after(0, lambda: self._put("状态刷新完成。\n", "ok"))

    def _mark_status(self):
        if not VERSION_FILE.exists():
            return
        try:
            data = json.loads(VERSION_FILE.read_text(encoding="utf-8"))
            updated = set()
            if data.get("skill_updates"):
                updated = {s.split("/")[0] if "/" in s else s for s in data["skill_updates"]}
            elif data.get("changed_files"):
                updated = {f.split("/")[0] for f in data["changed_files"] if f.startswith("gxtz-")}
            def do():
                for item in self.tree.get_children():
                    v = self.tree.item(item, "values")
                    if v and v[0] in updated:
                        self.tree.item(item, values=(v[0], v[1], "有更新"), tags=("behind",))
            self.root.after(0, do)
        except Exception:
            pass

    def _act_check(self):
        self._thread(self._check)

    def _check(self):
        self.root.after(0, lambda: self._head("检查 GitHub 远程更新"))
        self.root.after(0, lambda: self._dot("● 检测中...", "dim"))

        remote_name, ok, err = git_fetch(timeout=90)
        if not ok:
            self.root.after(0, lambda: self._put("[失败] " + err, "err"))
            self.root.after(0, lambda: self._dot("⚠ 连接失败", "danger"))
            self.root.after(0, lambda: self._refresh())
            return

        self.root.after(0, lambda: self._put("fetch 成功 ({})，正在对比版本...".format(remote_name), "ok"))
        local = run_git(["rev-parse", "HEAD"])[1]
        remote = run_git(["rev-parse", "origin/main"])[1]

        if not local or not remote:
            self.root.after(0, lambda: self._put("[失败] 无法获取版本信息", "err"))
            self.root.after(0, lambda: self._refresh())
            return

        if local == remote:
            self.root.after(0, lambda: self._put("已是最新版本，无需更新。", "ok"))
            self.root.after(0, lambda: self._dot("● 已是最新", "success"))
            self.root.after(0, lambda: self._refresh())
            return

        code, _, _ = run_git(["merge-base", "--is-ancestor", local, remote])
        if code == 0:
            self.root.after(0, lambda: self._put("\n发现远程新版本！变更文件：\n", "warn"))
            changed = run_git(["diff", "--name-only", local, remote])[1]
            if changed:
                for f in changed.split("\n"):
                    tag = "[SKILL]" if f.endswith("SKILL.md") else ("[脚本]" if "_common/" in f else "[其他]")
                    self.root.after(0, lambda f=f, tag=tag: self._put("  {} {}".format(tag, f),
                        "ok" if f.endswith("SKILL.md") else "warn"))

            comp = str(SKILLS_ROOT / "compare_skill_versions.py")
            if Path(comp).exists():
                r = subprocess.run(
                    ["python", comp, local, remote],
                    cwd=str(SKILLS_ROOT), capture_output=True, text=True,
                    timeout=30, creationflags=CREATIONFLAGS)
                if r.stdout.strip():
                    for line in r.stdout.split("\n"):
                        line = line.strip()
                        if line and not line.startswith("[VERSION_JSON]"):
                            self.root.after(0, lambda l=line: self._put(l, "ok" if "→" in l else "info"))

            self.root.after(0, lambda: self._put("\n请点击「拉取技能更新」获取最新版本。", "bold"))
            self.root.after(0, lambda: self._dot("● 有新版本", "danger"))
        else:
            self.root.after(0, lambda: self._put("已是最新版本，无需更新。", "ok"))
            self.root.after(0, lambda: self._dot("● 已是最新", "success"))
        self.root.after(0, lambda: self._refresh())

    def _act_pull(self):
        if not messagebox.askyesno("确认拉取",
                                    "即将从 GitHub 拉取最新技能更新。\n\n"
                                    "拉取后请重启 TRAE IDE 使技能生效。\n\n确认继续？"):
            return
        self._thread(self._pull)

    def _pull(self):
        self.root.after(0, lambda: self._head("拉取技能更新"))
        self.root.after(0, lambda: self._dot("● 拉取中...", "dim"))
        branch = run_git(["rev-parse", "--abbrev-ref", "HEAD"])[1] or "main"
        self.root.after(0, lambda: self._put("分支: " + branch, "info"))

        ok = git_pull(branch, timeout=120)
        if not ok:
            self.root.after(0, lambda: self._put("[失败] 拉取失败", "err"))
            self.root.after(0, lambda: self._dot("⚠ 拉取失败", "danger"))
            self.root.after(0, lambda: self._refresh())
            return

        self._put("", "info")
        self._put("更新后的技能版本：", "hdr")
        skill_dirs = sorted([d.name for d in SKILLS_ROOT.iterdir()
                              if d.is_dir() and d.name.startswith("gxtz-")])
        for sd in skill_dirs:
            ver = extract_version(sd)
            self.root.after(0, lambda sd=sd, ver=ver: self._put("  {}: v{}".format(sd, ver), "ok"))

        self.root.after(0, lambda: self._put("\n拉取完成。请重启 TRAE IDE 使技能生效。", "bold"))
        self.root.after(0, lambda: self._dot("● 已更新", "success"))
        self.root.after(0, lambda: self._refresh())


def main():
    ClientGUI()


if __name__ == "__main__":
    main()
