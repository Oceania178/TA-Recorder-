; Included by electron-builder's NSIS installer (package.json build.nsis.include).
;
; A REAL uninstall vs an update: during an update electron-builder runs the old uninstaller silently with
; "/S /KEEP_APP_DATA" plus "--updated" (or "--delete-app-data" when the new installer was started with that flag)
; — see app-builder-lib/templates/nsis/include/installUtil.nsh. So a real uninstall is one with neither
; "--updated" nor "/KEEP_APP_DATA" on its command line. Only then are the recordings, the app's data and the
; cleanup task removed (APP review I2c, m-R3).

; Sets $R2 to "purge" on a real uninstall, "keep" during an update.
!macro taRealUninstall
  StrCpy $R2 "purge"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $R2 "keep"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    StrCpy $R2 "keep"
  ${EndIf}
  ClearErrors
!macroend

; Runs INSIDE Section "un.install" (APP review 2, I-R1): after the TA confirmed on the uninstaller's pages (Cancel
; there deletes nothing) and after electron-builder's "app is running" check, and before the program files are
; removed (the app is still there to run). On a real uninstall it first deletes this user's recordings in every
; recordings folder the app has used, then the app's data: settings, queue, log, Gemini key and tickets (only
; call folders carrying the app's own marker). The set-up notice tells the TA: "Uninstalling deletes your
; recordings and the app's settings, including your Gemini key." electron-builder then also removes the
; app-data folder (nsis.deleteAppDataOnUninstall).
; After that, electron-builder's own default removal, unchanged (copied from templates/nsis/uninstaller.nsh).
!macro customRemoveFiles
  !insertmacro taRealUninstall
  ${If} $R2 == "purge"
    DetailPrint "Deleting TA Call Recorder recordings and settings…"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-purge'
  ${EndIf}

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend

; At the end of the uninstall: delete the per-user Task Scheduler task the app created (D-140), on a real
; uninstall only. The name must match CLEANUP_TASK_NAME in src/main/cleanupTask.ts.
!macro customUnInstall
  !insertmacro taRealUninstall
  ${If} $R2 == "purge"
    nsExec::Exec 'schtasks.exe /Delete /TN "TA Call Recorder cleanup" /F'
  ${EndIf}
!macroend
