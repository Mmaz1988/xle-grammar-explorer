@echo off
rem Puts "XLE Grammar Explorer" on your desktop, with its icon. Optional - the .cmd beside this
rem one runs the explorer whether or not you ever use this.
setlocal
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\XLE Grammar Explorer.lnk');" ^
  "$s.TargetPath = '%~dp0XLE Grammar Explorer.cmd';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%~dp0app\AppIcon.ico';" ^
  "$s.Description = 'Explore and edit XLE grammars';" ^
  "$s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo Put "XLE Grammar Explorer" on your desktop.
)
pause
