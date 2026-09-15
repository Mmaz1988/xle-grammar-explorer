@echo off
rem What Windows runs: the explorer itself, in a console window you can watch and
rem interrupt. The window is the point — a browser-based tool whose server is invisible
rem is one nobody can stop when something goes wrong with the browser. Ctrl-C here
rem always works, whatever the browser did. Jupyter keeps its console for the same
rem reason.
rem
rem Used by both copies: this file sits at the top of the repository and beside the code
rem inside the packaged folder. It works out which by looking for the code.
setlocal
cd /d "%~dp0"

if exist "%~dp0app\server\launch.mjs" (
  set "ROOT=%~dp0app"
  set "XLE_APP_BUNDLE=1"
) else (
  set "ROOT=%~dp0"
  set "XLE_APP_BUNDLE=0"
)

if not exist "%ROOT%\server\launch.mjs" (
  echo Cannot find the explorer's files. Keep this script in the folder it came in.
  echo.
  pause
  exit /b 1
)

rem A window opened from Explorer does not always have node on PATH, and the installer
rem puts it somewhere predictable, so look there too.
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo Node.js is needed to run the explorer, and is not installed on this PC.
  echo Install it from https://nodejs.org and open this again.
  echo.
  rem Said twice on purpose: the window may be behind something, and this is the one
  rem failure someone can fix in a minute if they are told where to go.
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.MessageBox]::Show('Node.js is needed to run the explorer, and is not installed on this PC.' + [Environment]::NewLine + [Environment]::NewLine + 'Open the download page?', 'XLE Grammar Explorer', 'YesNo') -eq 'Yes') { Start-Process 'https://nodejs.org/en/download' }" >nul 2>nul
  pause
  exit /b 1
)

"%NODE%" "%ROOT%\server\launch.mjs"
set STATUS=%ERRORLEVEL%

rem Hold the window open on failure; the reason is above and would otherwise vanish
rem with the window. A clean exit is the explorer having been closed.
if not "%STATUS%"=="0" (
  echo.
  pause
)
exit /b %STATUS%
