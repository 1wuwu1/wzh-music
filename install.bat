@echo off
rem Install REKG source dependencies. Keep this file ASCII-only.
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "api\node_modules" (
    echo Installing music API dependencies...
    pushd api
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        popd
        echo API dependency installation failed.
        pause
        exit /b 1
    )
    popd
)

if not exist "node_modules" (
    echo Installing Electron dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo Electron dependency installation failed.
        pause
        exit /b 1
    )
)

echo.
echo Dependencies are ready.
echo Browser version: run start.bat
echo Desktop dev version: run npm run start:electron
pause
