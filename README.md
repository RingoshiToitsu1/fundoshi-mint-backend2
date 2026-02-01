# FUNDOSHI NFT Mint Backend

Production-ready Solana NFT minting backend for Candy Machine v3.

## Architecture

- **Backend-mediated mint** (Option A, no guards)
- Backend constructs and partially signs all transactions
- Frontend (Lovable) only connects wallet and signs transactions
- Strict one-mint-per-wallet enforcement

## Environment Variables

Required in Railway:

```
AUTHORITY_SECRET_KEY=[64,23,45,...] # JSON array of 64 numbers
PORT=3000 # Railway sets this automatically
```

## Deployment to Railway

1. Push code to GitHub
2. Connect repository to Railway
3. Set environment variable: `AUTHORITY_SECRET_KEY`
4. Deploy

## API Endpoints

### `POST /mint/check`
Check if wallet is eligible to mint.

Request:
```json
{
  "wallet": "USER_WALLET_ADDRESS"
}
```

Response:
```json
{
  "eligible": true
}
```
or
```json
{
  "eligible": false,
  "reason": "Wallet not on whitelist"
}
```

### `POST /mint`
Create mint transaction for eligible wallet.

Request:
```json
{
  "wallet": "USER_WALLET_ADDRESS"
}
```

Response:
```json
{
  "transaction": "BASE64_ENCODED_TRANSACTION"
}
```

### `POST /rpc`
Proxy endpoint for Solana RPC calls (avoids CORS).

Request: Standard Solana JSON-RPC request
Response: Raw Solana JSON-RPC response

### `POST /mint/confirm` (Optional)
Record successful mint after transaction confirmation.

Request:
```json
{
  "wallet": "USER_WALLET_ADDRESS",
  "signature": "TRANSACTION_SIGNATURE"
}
```

## Data Files

### `whitelist.json`
Array of wallet addresses allowed to mint:
```json
[
  "WALLET_ADDRESS_1",
  "WALLET_ADDRESS_2"
]
```

### `minted.json`
Array of wallet addresses that have already minted:
```json
[
  "WALLET_ADDRESS_1"
]
```

## Frontend Integration (Lovable)

```javascript
// 1. Check eligibility
const checkResponse = await fetch('https://fundoshi-mint-backend-production.up.railway.app/mint/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet: userWallet })
});
const { eligible, reason } = await checkResponse.json();

// 2. Get mint transaction
const mintResponse = await fetch('https://fundoshi-mint-backend-production.up.railway.app/mint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet: userWallet })
});
const { transaction } = await mintResponse.json();

// 3. Deserialize and sign with Phantom
const tx = Transaction.from(Buffer.from(transaction, 'base64'));
const signedTx = await window.solana.signTransaction(tx);

// 4. Send via RPC proxy
const rpcResponse = await fetch('https://fundoshi-mint-backend-production.up.railway.app/rpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [
      signedTx.serialize().toString('base64'),
      { encoding: 'base64' }
    ]
  })
});

// 5. Confirm mint (optional)
const confirmResponse = await fetch('https://fundoshi-mint-backend-production.up.railway.app/mint/confirm', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    wallet: userWallet,
    signature: txSignature 
  })
});
```

## Configuration

- **Candy Machine ID**: `3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ`
- **Network**: Solana Mainnet
- **RPC**: `https://solana-mainnet.gateway.tatum.io`

## Security Notes

- ✅ Authority keypair stored only in Railway environment
- ✅ No private keys in code or git
- ✅ Whitelist enforcement on backend
- ✅ One-mint-per-wallet enforcement on backend
- ✅ Frontend cannot bypass restrictions

## Git Workflow

Only commit these files:
- `server.js`
- `package.json`
- `whitelist.json`
- `minted.json`
- `README.md`
- `.gitignore`

Commands:
```bash
git add server.js package.json whitelist.json minted.json README.md .gitignore
git commit -m "Update backend"
git push origin main
```

## Candy Machine Details

Do NOT:
- ❌ Regenerate authority
- ❌ Redeploy Candy Machine
- ❌ Rotate keys
- ❌ Modify Candy Machine configuration

The Candy Machine is already deployed and configured. This backend works with the existing deployment.
