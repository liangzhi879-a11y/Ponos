; ============================================================
; Ponos 自定义 NSIS 脚本 — 更新安装支持
; 识别系统已安装的 Ponos → 比较版本 → 弹窗确认 → 覆盖更新安装（保留用户数据）
; 通过 electron-builder.yml → nsis.include 注入到 electron-builder 模板
;
; 三档行为：
;   · 同版本（installed == ${VERSION}）→ 静默跳过弹窗（重装无需用户确认）
;   · 降级（installed > ${VERSION}）  → 弹窗警告，默认按钮为【否】
;   · 升级（installed < ${VERSION}）  → 弹窗提示，默认按钮为【是】
;   · 版本号读不出来                 → 弹窗通用提示，默认按钮为【是】
; ============================================================

!include LogicLib.nsh

; ---- 可选资源安装相关变量（仅安装器需要；卸载器编译时排除避免 NSIS 6001 警告）----
!ifndef BUILD_UNINSTALLER
  Var installSkillsPack   ; "1"=安装技能包（默认） "0"=跳过
  Var skillTargetDir      ; 目标技能库目录
  Var skillCopyExit       ; xcopy 退出码
  Var skillMarkerH        ; marker 文件句柄
  Var installAgentsPack   ; "1"=安装内置 agents 模板（默认）"0"=跳过
  Var agentsTargetDir     ; 目标 agents 目录
  Var agentsCopyExit      ; xcopy 退出码
  Var agentsMarkerH       ; marker 文件句柄
  Var installMemoryPack   ; "1"=安装全局记忆 starter 模板（默认）"0"=跳过
  Var memoryTargetDir     ; 目标 memory 目录
  Var memoryCopyExit      ; xcopy 退出码
  Var memoryMarkerH       ; marker 文件句柄
  Var installToolsPack    ; "1"=安装内置 CLI 工具（默认）"0"=跳过
  Var toolsTargetDir      ; 目标 tools 目录
  Var toolsCopyExit       ; xcopy 退出码
  Var toolsMarkerH        ; marker 文件句柄
!endif

!macro customInit
  ; ---- 1. 检测系统是否已安装 Ponos ----
  ; INSTALL_REGISTRY_KEY = Software\<APP_GUID>，由 electron-builder 在 install 时写入 InstallLocation
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R0 != ""
    ; ---- 2. 读取已安装版本号 ----
    ; UNINSTALL_REGISTRY_KEY = Software\Microsoft\Windows\CurrentVersion\Uninstall\<UNINSTALL_APP_KEY>
    ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion

    ; ---- 3. 比较版本号（纯 NSIS 实现，不依赖 System::Call / FileFunc.nsh）----
    ; 用 $R2 标记状态："0" 同版 / "1" 已装版本更高（降级） / "-1" 本次版本更高（升级） / "unknown" 无法读取
    ; 说明：electron-builder 附带的 NSIS 发行版有两个坑——
    ;   1) FileFunc.nsh 被裁剪，${VersionCompare} 无法编译（实测 makensis 报 Invalid command）；
    ;   2) System 插件（System::Call）返回值捕获异常：实测 GetTickCount/StrCmpLogicalW
    ;      等调用的返回值 pop 出来为空字符串，导致任何比较都落入 else 分支 → 一律误判为“降级”。
    ; 因此这里改用纯 NSIS 指令：按 '.' 拆分版本号各段，用 IntCmp 逐段数值比较，
    ; 天然支持 "1.10.0" > "1.9.0"（10 > 9 数值比较），空段按 0 处理（"2.3" == "2.3.0"）。
    ${if} $R1 == ""
      StrCpy $R2 "unknown"
    ${else}
      ; $R4 = 已安装版本剩余串，$R5 = 安装包版本剩余串；$R6/$R9 = 当前数字段
      StrCpy $R4 "$R1"
      StrCpy $R5 "${VERSION}"
      StrCpy $R2 "0"
    vc_compare_loop:
      ; --- 取 $R4 的下一段（数字部分）→ $R6，剩余 → $R4 ---
      StrCpy $R6 ""
      StrCpy $R7 "$R4"
    vc_a_scan:
      StrCmp $R7 "" vc_a_done
      StrCpy $R8 "$R7" 1
      StrCmp $R8 "." vc_a_dot
      StrCpy $R6 "$R6$R8"
      StrCpy $R7 "$R7" "" 1
      Goto vc_a_scan
    vc_a_dot:
      StrCpy $R4 "$R7" "" 1
      Goto vc_seg_a_ready
    vc_a_done:
      StrCpy $R4 ""
    vc_seg_a_ready:
      ; --- 取 $R5 的下一段（数字部分）→ $R9，剩余 → $R5 ---
      StrCpy $R9 ""
      StrCpy $R7 "$R5"
    vc_b_scan:
      StrCmp $R7 "" vc_b_done
      StrCpy $R8 "$R7" 1
      StrCmp $R8 "." vc_b_dot
      StrCpy $R9 "$R9$R8"
      StrCpy $R7 "$R7" "" 1
      Goto vc_b_scan
    vc_b_dot:
      StrCpy $R5 "$R7" "" 1
      Goto vc_seg_b_ready
    vc_b_done:
      StrCpy $R5 ""
    vc_seg_b_ready:
      ; --- 数值比较当前段 ---
      IntCmp $R6 $R9 vc_seg_equal vc_less vc_greater
    vc_seg_equal:
      ; 两段相等：任一方还有剩余段则继续，否则同版本
      StrCmp $R4 "" 0 vc_compare_loop
      StrCmp $R5 "" vc_same vc_compare_loop
    vc_less:
      StrCpy $R2 "-1"
      Goto vc_done
    vc_greater:
      StrCpy $R2 "1"
      Goto vc_done
    vc_same:
      StrCpy $R2 "0"
    vc_done:
    ${endIf}

    ; ---- 4. 分档弹窗 ----
    ${if} $R2 == "0"
      ; 同版本：无需弹窗，直接进入安装流程（覆盖写入相同文件）
    ${else}
      ${ifNot} ${Silent}
        ${if} $R2 == "1"
          ; 降级：MB_DEFBUTTON2 让【否】成为默认按钮，防止误点
          MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
            "检测到当前已安装 Ponos 版本（$R1）高于本次安装包版本（${VERSION}）。$\r$\n$\r$\n继续将把现有安装覆盖为较低版本 ${VERSION}，并保留您的数据与设置。$\r$\n$\r$\n点击【是】继续降级，点击【否】退出安装。" \
            IDYES lbl_continue_upgrade
        ${elseif} $R2 == "unknown"
          ; 版本号读取失败（可能来自旧版或异常安装）
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
            "检测到系统已安装 Ponos，但无法读取其版本号。$\r$\n$\r$\n本次安装将覆盖现有文件并保留您的数据与设置。$\r$\n$\r$\n点击【是】继续，点击【否】退出安装。" \
            IDYES lbl_continue_upgrade
        ${else}
          ; $R2 == "-1"，升级
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
            "检测到系统已安装 Ponos 版本：$R1$\r$\n$\r$\n本次将升级到 ${VERSION} 并保留您的数据与设置。$\r$\n$\r$\n点击【是】继续升级，点击【否】退出安装。" \
            IDYES lbl_continue_upgrade
        ${endIf}
        Quit
        lbl_continue_upgrade:
      ${endIf}
    ${endIf}
  ${endIf}

  ; ---- 5-8. 可选资源选择 ----
  ; 新装/升级/重装：交互模式都问 4 项（用户可单选取消某类，升级时也能拿到新增资源）
  ; 静默安装（/S）：默认全部署，不弹窗
  ; marker 不再是 gate，仅作 "上次部署版本" 记录
  !ifndef BUILD_UNINSTALLER
    ${if} ${Silent}
      ; 静默安装：默认全部署
      StrCpy $installSkillsPack "1"
      StrCpy $installAgentsPack "1"
      StrCpy $installMemoryPack "1"
      StrCpy $installToolsPack "1"
    ${else}
      ; 交互安装：分别询问（无论是否已存在 marker）
      StrCpy $installSkillsPack "0"
      StrCpy $installAgentsPack "0"
      StrCpy $installMemoryPack "0"
      StrCpy $installToolsPack "0"

      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否同时安装技能包（66 个技能）？$\r$\n$\r$\n技能包包含全部申报、文档处理、浏览器自动化等 66 个技能，安装到您的用户技能库（~\.ponos\skills）。已有内容不会被覆盖（仅新增/更新的文件生效）。$\r$\n$\r$\n点击【是】安装技能包，点击【否】跳过。" \
        IDYES lbl_skillpack_yes
      Goto lbl_skillpack_done
      lbl_skillpack_yes:
      StrCpy $installSkillsPack "1"
      lbl_skillpack_done:

      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否同时安装内置 Agents 模板（11 个专家代理）？$\r$\n$\r$\nAgents 包含材料撰写、表格处理、审计核对、申报打包、文档处理等专业代理模板，安装到您的用户代理库（~\.ponos\agents）。已有内容不会被覆盖。$\r$\n$\r$\n点击【是】安装 Agents，点击【否】跳过。" \
        IDYES lbl_agentpack_yes
      Goto lbl_agentpack_done
      lbl_agentpack_yes:
      StrCpy $installAgentsPack "1"
      lbl_agentpack_done:

      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否同时安装全局记忆 starter 模板（7 个主题）？$\r$\n$\r$\n全局记忆包含 code-style / communication / workflow / finance / office-docs / policy / project-application 共 7 个主题的空白 starter，安装到您的用户记忆库（~\.ponos\memory\personal）。已有内容不会被覆盖。$\r$\n$\r$\n点击【是】安装 starter，点击【否】跳过。" \
        IDYES lbl_memorypack_yes
      Goto lbl_memorypack_done
      lbl_memorypack_yes:
      StrCpy $installMemoryPack "1"
      lbl_memorypack_done:

      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否同时安装内置 CLI 工具（ponos-helper 等基础工具）？$\r$\n$\r$\n内置工具包含 ponos-helper（文件批量 hash / 重命名 / 统计等），安装到您的用户工具库（~\.ponos\tools）。$\r$\n$\r$\n点击【是】安装内置工具，点击【否】跳过。" \
        IDYES lbl_toolspack_yes
      Goto lbl_toolspack_done
      lbl_toolspack_yes:
      StrCpy $installToolsPack "1"
      lbl_toolspack_done:
    ${endIf}
  !endif
!macroend

; ============================================================
; 安装阶段：将可选技能包从安装目录复制到用户技能库
; 源：$INSTDIR\resources\runtime\skills（extraResources 已随安装包携带）
; 目标：%USERPROFILE%\.ponos\skills
; 幂等：marker（.skillpack.json）存在则跳过，保留用户后续定制。
; ============================================================
!ifndef BUILD_UNINSTALLER
!macro customInstall
  ${if} $installSkillsPack == "1"
    StrCpy $skillTargetDir "$%USERPROFILE%\.ponos\skills"
    ${if} $skillTargetDir != ""
      CreateDirectory "$skillTargetDir"
      ; /E 递归含空目录 /I 目标视为目录 /D 仅复制日期更新的（不覆盖用户新改） /Y 覆盖只读
      ExecWait 'cmd /c xcopy /E /I /D /Y "$INSTDIR\resources\runtime\skills\*.*" "$skillTargetDir\"' $skillCopyExit
      ${if} $skillCopyExit == 0
        FileOpen $skillMarkerH "$skillTargetDir\.skillpack.json" w
        FileWrite $skillMarkerH '{"installedBy":"Ponos ${VERSION}","installedAt":"${__DATE__}","skills":66,"deployedCount":66}'
        FileClose $skillMarkerH
      ${endIf}
    ${endIf}
  ${endIf}

  ; ---- Agents 部署 ----
  ; 源：$INSTDIR\resources\runtime\agents（extraResources 已随安装包携带）
  ; 目标：%USERPROFILE%\.ponos\agents
  ; 用户已确认要安装：xcopy /D 保留用户自定义内容；marker 记录部署版本。
  ${if} $installAgentsPack == "1"
    StrCpy $agentsTargetDir "$%USERPROFILE%\.ponos\agents"
    ${if} $agentsTargetDir != ""
      CreateDirectory "$agentsTargetDir"
      ExecWait 'cmd /c xcopy /E /I /D /Y "$INSTDIR\resources\runtime\agents\*.*" "$agentsTargetDir\"' $agentsCopyExit
      ${if} $agentsCopyExit == 0
        FileOpen $agentsMarkerH "$agentsTargetDir\.agents-pack.json" w
        FileWrite $agentsMarkerH '{"installedBy":"Ponos ${VERSION}","installedAt":"${__DATE__}","agents":11,"deployedCount":11}'
        FileClose $agentsMarkerH
      ${endIf}
    ${endIf}
  ${endIf}

  ; ---- Memory 部署 ----
  ; 源：$INSTDIR\resources\runtime\memory（extraResources 已随安装包携带）
  ; 目标：%USERPROFILE%\.ponos\memory
  ; 用户已确认：xcopy /D 仅覆盖日期更新的文件（starter 模板不会被用户内容覆盖）。
  ${if} $installMemoryPack == "1"
    StrCpy $memoryTargetDir "$%USERPROFILE%\.ponos\memory"
    ${if} $memoryTargetDir != ""
      CreateDirectory "$memoryTargetDir"
      ExecWait 'cmd /c xcopy /E /I /D /Y "$INSTDIR\resources\runtime\memory\*.*" "$memoryTargetDir\"' $memoryCopyExit
      ${if} $memoryCopyExit == 0
        FileOpen $memoryMarkerH "$memoryTargetDir\.memory-pack.json" w
        FileWrite $memoryMarkerH '{"installedBy":"Ponos ${VERSION}","installedAt":"${__DATE__}","themes":7,"deployedCount":7}'
        FileClose $memoryMarkerH
      ${endIf}
    ${endIf}
  ${endIf}

  ; ---- Tools 部署 ----
  ; 源：$INSTDIR\resources\runtime\tools（extraResources 已随安装包携带）
  ; 目标：%USERPROFILE%\.ponos\tools
  ; 用户已确认：xcopy /D 保留用户后续添加的工具。
  ${if} $installToolsPack == "1"
    StrCpy $toolsTargetDir "$%USERPROFILE%\.ponos\tools"
    ${if} $toolsTargetDir != ""
      CreateDirectory "$toolsTargetDir"
      ExecWait 'cmd /c xcopy /E /I /D /Y "$INSTDIR\resources\runtime\tools\*.*" "$toolsTargetDir\"' $toolsCopyExit
      ${if} $toolsCopyExit == 0
        FileOpen $toolsMarkerH "$toolsTargetDir\.tools-pack.json" w
        FileWrite $toolsMarkerH '{"installedBy":"Ponos ${VERSION}","installedAt":"${__DATE__}","tools":1,"deployedCount":1}'
        FileClose $toolsMarkerH
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
!endif