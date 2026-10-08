; Ghost Hands: extra NSIS steps for electron-builder.
; app.setLoginItemSettings() writes the autostart value under the AppUserModelId;
; an uninstalled app must not stay in the Windows startup list.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "space.iatnaod.ghosthands"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "space.iatnaod.ghosthands"
  ${endIf}
!macroend
