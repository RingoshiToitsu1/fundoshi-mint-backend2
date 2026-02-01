# FUNDOSHI Deployment Guide

## Initial Setup

### 1. Backend Deployment to Railway

#### Create Railway Project
1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Connect your GitHub repository

#### Set Environment Variable
In Railway dashboard:
1. Go to your project
2. Click "Variables" tab
3. Add variable:
   - **Name**: `AUTHORITY_SECRET_KEY`
   - **Value**: Your JSON array of 64 numbers (already configured, DO NOT CHANGE)

Example format (DO NOT USE THIS, use your actual key):
```
[64,23,45,67,89,12,34,56,78,90,11,22,33,44,55,66,77,88,99,00,12,34,56,78,90,11,22,33,44,55,66,77,88,99,00,11,22,33,44,55,66,77,88,99,00,11,22,33,44,55,66,77,88,99,00,11,22,33,44,55,66,77,88,99,00]
```

#### Deploy
Railway will automatically deploy when you push to your GitHub repository.

Your backend URL will be:
```
https://fundoshi-mint-backend-production.up.railway.app
```

---

## Git Workflow

### Files to Track
```bash
server.js
package.json
whitelist.json
minted.json
README.md
.gitignore
```

### Initial Commit (First Time Only)
```bash
git init
git add server.js package.json whitelist.json minted.json README.md .gitignore
git commit -m "Initial FUNDOSHI mint backend"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### Update Server Code
```bash
git add server.js
git commit -m "Update server logic"
git push origin main
```

### Update Whitelist
```bash
git add whitelist.json
git commit -m "Update whitelist"
git push origin main
```

### Update Multiple Files
```bash
git add server.js whitelist.json
git commit -m "Update server and whitelist"
git push origin main
```

### Check Status
```bash
git status
git log --oneline
```

---

## Managing Whitelist

Edit `whitelist.json` to add wallet addresses:

```json
[
  "9XqvG3pF4mK2nH5wL7jR8tY6sD1aE3cB9vN4xZ2mK7pQ",
  "5tR9yK2pL3mN4xZ6wQ8sD1aE7vB3cF5hJ9nM2pK4rT6",
  "3cF5hJ9nM2pK4rT6yU8wQ1sD7aE5vB9xZ2mK3pL4nR7"
]
```

Then commit and push:
```bash
git add whitelist.json
git commit -m "Add wallets to whitelist"
git push origin main
```

---

## Testing the Backend

### Test Eligibility Check
```bash
curl -X POST https://fundoshi-mint-backend-production.up.railway.app/mint/check \
  -H "Content-Type: application/json" \
  -d '{"wallet":"YOUR_WALLET_ADDRESS"}'
```

Expected response:
```json
{"eligible":true}
```
or
```json
{"eligible":false,"reason":"Wallet not on whitelist"}
```

### Test Health Endpoint
```bash
curl https://fundoshi-mint-backend-production.up.railway.app/health
```

Expected response:
```json
{"status":"healthy","timestamp":"2025-01-31T..."}
```

### View Backend Info
```bash
curl https://fundoshi-mint-backend-production.up.railway.app/
```

---

## Lovable Frontend Setup

### 1. Install Dependencies
In your Lovable project, ensure you have:
```json
{
  "dependencies": {
    "@solana/web3.js": "^1.95.8"
  }
}
```

### 2. Add Mint Integration
Copy the code from `lovable-frontend-example.js` into your Lovable app.

### 3. Update Backend URL
Make sure the backend URL in your frontend code matches:
```javascript
const BACKEND_URL = 'https://fundoshi-mint-backend-production.up.railway.app';
```

### 4. Test Flow
1. Connect Phantom wallet
2. Check eligibility
3. Click mint button
4. Sign transaction in Phantom
5. Wait for confirmation

---

## Monitoring

### View Logs in Railway
1. Go to your Railway project
2. Click on the service
3. Click "Deployments" tab
4. Click on the latest deployment
5. View logs in real-time

### Check Minted Wallets
View `minted.json` in your repository to see which wallets have minted.

---

## Troubleshooting

### "Wallet not on whitelist"
- Add wallet to `whitelist.json`
- Commit and push changes
- Wait for Railway to redeploy (automatic)

### "Wallet has already minted"
- Each wallet can only mint once
- Check `minted.json` to verify

### "Failed to fetch"
- Check CORS settings (should be enabled in server.js)
- Verify backend URL is correct
- Check Railway deployment status

### "Transaction failed"
- Check Candy Machine has items remaining
- Verify wallet has enough SOL for transaction fees
- Check Solana network status

### Backend not responding
- Check Railway logs for errors
- Verify `AUTHORITY_SECRET_KEY` environment variable is set
- Check Railway service status

---

## Security Checklist

✅ Authority keypair stored only in Railway environment variable
✅ No private keys in git repository
✅ `.gitignore` prevents committing sensitive files
✅ Whitelist enforcement on backend
✅ One-mint-per-wallet enforcement on backend
✅ Frontend cannot bypass backend restrictions

---

## Critical Reminders

### DO NOT:
❌ Regenerate authority keypair
❌ Redeploy Candy Machine
❌ Rotate keys without careful planning
❌ Commit secrets to git
❌ Modify Candy Machine configuration

### DO:
✅ Keep authority secret in Railway environment only
✅ Update whitelist via git
✅ Monitor minted.json for successful mints
✅ Test on devnet/testnet before mainnet changes
✅ Back up your authority keypair securely offline

---

## Support

If you encounter issues:
1. Check Railway logs
2. Review this deployment guide
3. Verify all environment variables
4. Test endpoints with curl
5. Check Solana network status at https://status.solana.com
