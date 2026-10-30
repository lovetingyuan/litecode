!macro LiteCodeContextMenu KEY TARGET
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\LiteCode" "" "Open with LiteCode"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\LiteCode" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\LiteCode" "MultiSelectModel" "Single"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\LiteCode\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --open-path "${TARGET}"'
!macroend

!macro LiteCodeRemoveContextMenu KEY TARGET
  ReadRegStr $R0 HKCU "Software\Classes\${KEY}\shell\LiteCode\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --open-path "${TARGET}"'
    DeleteRegKey HKCU "Software\Classes\${KEY}\shell\LiteCode"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LiteCodeContextMenu "*" "%1"
  ; A final dot prevents a drive root's trailing backslash from escaping the closing quote.
  !insertmacro LiteCodeContextMenu "Directory" "%1\."
  !insertmacro LiteCodeContextMenu "Directory\Background" "%V\."
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro LiteCodeRemoveContextMenu "*" "%1"
  !insertmacro LiteCodeRemoveContextMenu "Directory" "%1\."
  !insertmacro LiteCodeRemoveContextMenu "Directory\Background" "%V\."
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
