@echo off
title AccessGuard - Auto Push

echo ============================================
echo     AccessGuard - Commit and Push
echo ============================================

REM --- Build a clean date/time stamp (yyyy-MM-dd_HH-mm-ss) ---
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set stamp=%%i

git status

set /p msg=Enter commit message (leave empty for auto):

if "%msg%"=="" (
    set msg=Update %stamp%
)

git add .

git diff --cached --quiet
if %errorlevel%==0 (
    echo.
    echo No changes to commit.
    pause
    exit /b
)

git commit -m "%msg%"

echo.
echo Pulling latest changes...
git pull --rebase origin main
if %errorlevel% neq 0 (
    echo.
    echo Rebase failed. Resolve conflicts and try again.
    pause
    exit /b
)

echo.
echo Pushing to GitHub...
git push origin main
if %errorlevel% neq 0 (
    echo Push failed.
    pause
    exit /b
)

echo.
echo Tagging this push as v%stamp% ...
git tag -a "v%stamp%" -m "%msg%"
git push origin "v%stamp%"

echo.
echo ============================================
echo Push completed successfully!
echo Tag: v%stamp%
echo ============================================
pause