Var StartScryppyWithWindows

!macro NSIS_HOOK_PREINSTALL
  ; Preserve the current preference during silent upgrades.
  StrCpy $StartScryppyWithWindows "0"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${If} $0 != ""
    StrCpy $StartScryppyWithWindows "1"
  ${EndIf}

  IfSilent scryppy_autostart_choice_done
  ${If} $LANGUAGE == ${LANG_PORTUGUESEBR}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Iniciar o ScryPuppy automaticamente ao entrar no Windows?$\r$\n$\r$\nVocê pode alterar esta opção depois nas Configurações do ScryPuppy." \
      /SD IDNO IDYES scryppy_autostart_enable IDNO scryppy_autostart_disable
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Start ScryPuppy automatically when you sign in to Windows?$\r$\n$\r$\nYou can change this later in ScryPuppy Settings." \
      /SD IDNO IDYES scryppy_autostart_enable IDNO scryppy_autostart_disable
  ${EndIf}

  scryppy_autostart_enable:
    StrCpy $StartScryppyWithWindows "1"
    Goto scryppy_autostart_choice_done

  scryppy_autostart_disable:
    StrCpy $StartScryppyWithWindows "0"

  scryppy_autostart_choice_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $StartScryppyWithWindows == "1"
    ; Clear a stale Task Manager override and register the installed executable.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\"'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The Tauri uninstaller removes the app data directories when the user
  ; selects the data-removal checkbox. Complete that choice by also removing
  ; the encryption and AI credentials kept in Windows Credential Manager.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    nsExec::ExecToLog '"$SYSDIR\cmdkey.exe" /delete:database-key-v1.Scryppy'
    nsExec::ExecToLog '"$SYSDIR\cmdkey.exe" /delete:context-key-v1.Scryppy'
    nsExec::ExecToLog '"$SYSDIR\cmdkey.exe" /delete:ai-api-key-v1.Scryppy'
  ${EndIf}

  ; Remove the Windows startup approval residue even when data is preserved.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
!macroend
