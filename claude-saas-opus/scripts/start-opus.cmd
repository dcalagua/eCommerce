@echo off
setlocal
pushd "%~dp0\..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File ".\claude-saas-opus\scripts\preflight.ps1" -RepoPath "."
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -File ".\claude-saas-opus\scripts\run-all.ps1" -RepoPath "." -Model "opus" -MaxRetries 3 -TransientRetries 3
set code=%errorlevel%
popd
exit /b %code%
:fail
set code=%errorlevel%
popd
exit /b %code%
