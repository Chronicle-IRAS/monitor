@echo off
setlocal

if "%DEPLOY_SERVER%"=="" (
  echo ERROR: DEPLOY_SERVER is not set.
  echo Run: set DEPLOY_SERVER=your.server.ip
  exit /b 1
)

set "SERVER=%DEPLOY_SERVER%"
set "REMOTE_DIR=/var/www/monitor-pro"
set "UPLOAD_DIR=/tmp/monitor-pro-upload"

echo [1/5] Building Vue production bundle...
call npm run build
if errorlevel 1 goto fail

if not exist "dist\index.html" (
  echo ERROR: Build output is missing: dist\index.html
  exit /b 1
)

echo [2/5] Checking SSH connection and remote directories...
ssh root@%SERVER% "rm -rf %UPLOAD_DIR% && mkdir -p %UPLOAD_DIR% %REMOTE_DIR%"
if errorlevel 1 goto fail

echo [optional] Checking remote FFmpeg version...
ssh root@%SERVER% "ffmpeg -version"
if errorlevel 1 echo WARNING: FFmpeg check failed. Continuing frontend static deployment...

echo [3/5] Uploading build output to remote temporary directory...
scp -r ".\dist" root@%SERVER%:%UPLOAD_DIR%/
if errorlevel 1 goto fail

echo [4/5] Replacing live static files and setting permissions...
ssh root@%SERVER% "rm -rf %REMOTE_DIR%/* && cp -a %UPLOAD_DIR%/dist/. %REMOTE_DIR%/ && rm -rf %UPLOAD_DIR% && chmod -R 755 %REMOTE_DIR%"
if errorlevel 1 goto fail

echo [5/5] Deploy completed: %SERVER%
exit /b 0

:fail
echo ERROR: Deploy failed. Check the error output above.
exit /b 1
