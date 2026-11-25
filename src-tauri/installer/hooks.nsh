; NSIS installer hooks (bundle > windows > nsis > installerHooks in tauri.conf.json).
;
; xdiagram-mcp.exe runs for as long as an MCP client (Claude Code, Claude Desktop, ...) keeps it
; open, and a running exe cannot be overwritten, so updating xdiagram would fail. It can be
; renamed, though: the installer moves it aside to xdiagram-mcp.exe.<n>.old, puts a copy back in
; its place (which nothing runs, so the install can overwrite it, and which keeps the server there
; if the install stops before that), and then installs the new one. The client keeps using the old
; copy until it restarts the server; old copies are deleted once nothing runs them (by the next
; install, the uninstaller, or xdiagram-mcp at start).

!macro XDIAGRAM_DELETE_OLD_MCP
  Push $0
  Push $1
  FindFirst $0 $1 "$INSTDIR\xdiagram-mcp.exe.*.old"
  ${DoWhile} $1 != ""
    Delete "$INSTDIR\$1"
    FindNext $0 $1
  ${Loop}
  FindClose $0
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro XDIAGRAM_DELETE_OLD_MCP
  ${If} ${FileExists} "$INSTDIR\xdiagram-mcp.exe"
    Push $0
    StrCpy $0 0
    ; The first free name: an old copy that is still running keeps its own.
    ${Do}
      IntOp $0 $0 + 1
      ${IfNot} ${FileExists} "$INSTDIR\xdiagram-mcp.exe.$0.old"
        Rename "$INSTDIR\xdiagram-mcp.exe" "$INSTDIR\xdiagram-mcp.exe.$0.old"
        CopyFiles /SILENT "$INSTDIR\xdiagram-mcp.exe.$0.old" "$INSTDIR\xdiagram-mcp.exe"
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $0 >= 50
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Copies nothing runs any more (the server was not in use).
  !insertmacro XDIAGRAM_DELETE_OLD_MCP
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro XDIAGRAM_DELETE_OLD_MCP
!macroend
