
@echo off

chcp 65001 >nul
echo 🚀 [1/4] 开始构建 Vue 生产环境产物...
call npm run build

echo 🧹 [2/4] 正在连接阿里云，清理历史残留代码...
ssh root@<YOUR_SERVER_IP> "rm -rf /var/www/monitor-pro/*"

ssh root@<YOUR_SERVER_IP> "ffmpeg -version"

echo 📤 [3/4] 正在将最新产物推送到服务器...
scp -r .\dist root@<YOUR_SERVER_IP>:/var/www/monitor-pro/

echo ⚙️ [4/4] 正在服务器端解包并配置 Nginx 权限...
ssh root@<YOUR_SERVER_IP> "mv /var/www/monitor-pro/dist/* /var/www/monitor-pro/ && rm -rf /var/www/monitor-pro/dist && chmod -R 755 /var/www/monitor-pro"

echo.
echo ✅ 部署大功告成！全网最新版本已上线！