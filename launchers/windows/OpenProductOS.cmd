@echo off
setlocal
set "LAUNCHER_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER_DIR%OpenProductOS.ps1"
if errorlevel 1 (
  echo.
  echo Open Product Operations OS could not start. Review the message above.
  pause
)
endlocal
