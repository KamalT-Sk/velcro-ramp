Write-Host "Starting Deployment..." -ForegroundColor Cyan

# 1. Push local changes
Write-Host "Pushing changes to GitHub..." -ForegroundColor Yellow
git add .
git commit -m "Deployment update"
git push origin main

# 2. Update the VPS
Write-Host "Updating VPS server..." -ForegroundColor Yellow
ssh root@187.124.13.111 "cd /root/velcro-ramp; git pull; npm install; pm2 restart velcro-ramp; pm2 status"

Write-Host "Done! Deployment Complete." -ForegroundColor Green
