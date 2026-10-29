; Included by electron-builder's NSIS installer (package.json build.nsis.include).
; electron-builder runs the old version's uninstaller with "--updated" during an update; these steps run only
; on a real uninstall, so an update keeps the recordings and the cleanup task.

; Before the files are removed (the app is still there): delete this user's recordings in every recordings
; folder the app has used (D-140, APP review I2c). The set-up notice tells the TA: "Uninstalling deletes your
; recordings." Only folders carrying the app's own marker are deleted.
!macro customUnInit
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-purge'
  ${EndIf}
!macroend

; After the files are removed: delete the per-user Task Scheduler task the app created (D-140).
; The name must match CLEANUP_TASK_NAME in src/main/cleanupTask.ts.
!macro customUnInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    nsExec::Exec 'schtasks.exe /Delete /TN "TA Call Recorder cleanup" /F'
  ${EndIf}
!macroend
