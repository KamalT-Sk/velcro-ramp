@echo off
echo 🚀 Starting Deployment...
echo 📤 Pushing changes to GitHub...
git add .
git commit -m "Redesign success modal to premium drawer"
git push origin main

echo 🌐 Updating VPS server (usevelcro.xyz)...
ssh root@usevelcro.xyz "cd /root/velcro-ramp; git pull; npm install; pm2 restart velcro-ramp; pm2 status"

echo ✅ Done! Deployment Complete.
pause
