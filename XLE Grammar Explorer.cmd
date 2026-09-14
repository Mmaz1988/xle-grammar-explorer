@echo off
rem Double-clickable launcher for Windows. Keeps the console open on failure so the
rem reason is readable rather than flashing past.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on PATH.
  echo Install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

node server\launch.mjs
if errorlevel 1 (
  echo.
  pause
)
