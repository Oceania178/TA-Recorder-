; Included by electron-builder's NSIS installer (package.json build.nsis.include).
; On uninstall, remove the per-user Task Scheduler task the app created on first run (D-140).
; The name must match CLEANUP_TASK_NAME in src/main/cleanupTask.ts.
!macro customUnInstall
  nsExec::Exec 'schtasks.exe /Delete /TN "TA Call Recorder cleanup" /F'
!macroend
