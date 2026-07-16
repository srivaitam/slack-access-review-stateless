@echo off
echo ==============================
echo   PUSHING CODE TO GITHUB
echo ==============================

cd /d %~dp0

echo Setting Git identity...
git config --global user.name "sri vaitam"
git config --global user.email "sir@vaitam.com"

echo Initializing git...
git init

echo Adding files...
git add .

echo Committing...
git commit -m "Auto push" 2>nul

echo Setting branch...
git branch -M main

echo Connecting to GitHub repo...
git remote remove origin 2>nul
git remote add origin https://github.com/srivaitam/slack-access-review-stateless.git

echo Pushing to GitHub...
git push -u origin main

echo ==============================
echo DONE ✅
pause