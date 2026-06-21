@echo off
setlocal
cd /d "%~dp0"

if not exist api_keys.env if exist api_keys.env.example copy api_keys.env.example api_keys.env >nul

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON_CMD=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python 3.9+ is required.
        pause
        exit /b 1
    )
    set "PYTHON_CMD=python"
)

%PYTHON_CMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 (
    echo Python 3.9+ is required.
    pause
    exit /b 1
)

%PYTHON_CMD% server.py
pause
