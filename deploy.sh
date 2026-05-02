#!/bin/bash

# Configuration
SERVER_IP="187.124.13.111"
SERVER_USER="root"
SERVER_PATH="/root/velcro-ramp"

echo "🚀 Starting Deployment..."

# 1. Push local changes to GitHub
echo "📤 Pushing changes to GitHub..."
git add .
git commit -m "Deployment update: $(date)"
git push origin main

# 2. Update the VPS
echo "🌐 Updating VPS server..."
ssh -t ${SERVER_USER}@${SERVER_IP} "cd ${SERVER_PATH} && git pull && npm install && pm2 restart velcro-ramp && pm2 logs velcro-ramp --lines 20 --no-daemon"

echo "✅ Deployment Complete!"
