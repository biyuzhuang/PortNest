!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\PortNest.lnk" "$INSTDIR\PortNest.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\PortNest.lnk"
!macroend
