@echo off
echo 🚀 Starting Deployment...
echo 📤 Pushing changes to GitHub...
git add .
git commit -m "Mobile and Status fixes"
git push origin main

echo 🌐 Updating VPS server...
ssh root@187.124.13.111 "cd /root/velcro-ramp; git pull; npm install; pm2 restart velcro-ramp; pm2 status"

echo ✅ Done! Deployment Complete.
pause
