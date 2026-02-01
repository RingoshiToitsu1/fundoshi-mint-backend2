// FUNDOSHI Mint - Lovable Frontend Integration
// This code shows how to integrate the minting flow in your Lovable app

import { Connection, Transaction, PublicKey } from '@solana/web3.js';

const BACKEND_URL = 'https://fundoshi-mint-backend-production.up.railway.app';
const RPC_ENDPOINT = 'https://solana-mainnet.gateway.tatum.io';

// Phantom wallet detection
const getPhantomProvider = () => {
  if ('phantom' in window) {
    const provider = window.phantom?.solana;
    if (provider?.isPhantom) {
      return provider;
    }
  }
  window.open('https://phantom.app/', '_blank');
  return null;
};

// Connect wallet
export const connectWallet = async () => {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error('Please install Phantom wallet');
  }

  try {
    const response = await provider.connect();
    const walletAddress = response.publicKey.toString();
    console.log('Connected wallet:', walletAddress);
    return walletAddress;
  } catch (error) {
    console.error('Error connecting wallet:', error);
    throw error;
  }
};

// Check mint eligibility
export const checkEligibility = async (walletAddress) => {
  try {
    const response = await fetch(`${BACKEND_URL}/mint/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ wallet: walletAddress }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to check eligibility');
    }

    const data = await response.json();
    return data; // { eligible: boolean, reason?: string }
  } catch (error) {
    console.error('Error checking eligibility:', error);
    throw error;
  }
};

// Mint NFT
export const mintNFT = async (walletAddress) => {
  const provider = getPhantomProvider();
  if (!provider || !provider.isConnected) {
    throw new Error('Wallet not connected');
  }

  try {
    // Step 1: Get mint transaction from backend
    console.log('Requesting mint transaction...');
    const mintResponse = await fetch(`${BACKEND_URL}/mint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ wallet: walletAddress }),
    });

    if (!mintResponse.ok) {
      const error = await mintResponse.json();
      throw new Error(error.error || 'Failed to create mint transaction');
    }

    const { transaction: base64Transaction } = await mintResponse.json();
    console.log('✅ Mint transaction received');

    // Step 2: Deserialize transaction
    const transactionBuffer = Buffer.from(base64Transaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);
    console.log('✅ Transaction deserialized');

    // Step 3: Sign transaction with Phantom
    console.log('Requesting signature from Phantom...');
    const signedTransaction = await provider.signTransaction(transaction);
    console.log('✅ Transaction signed');

    // Step 4: Serialize signed transaction
    const serializedTransaction = signedTransaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });
    const signedBase64 = serializedTransaction.toString('base64');

    // Step 5: Send transaction via RPC proxy
    console.log('Sending transaction...');
    const rpcResponse = await fetch(`${BACKEND_URL}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          signedBase64,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed'
          }
        ]
      })
    });

    const rpcData = await rpcResponse.json();
    
    if (rpcData.error) {
      throw new Error(rpcData.error.message || 'Transaction failed');
    }

    const signature = rpcData.result;
    console.log('✅ Transaction sent:', signature);

    // Step 6: Wait for confirmation
    console.log('Waiting for confirmation...');
    await confirmTransaction(signature);
    console.log('✅ Transaction confirmed');

    // Step 7: Record mint on backend (optional)
    try {
      await fetch(`${BACKEND_URL}/mint/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet: walletAddress,
          signature: signature
        })
      });
      console.log('✅ Mint recorded on backend');
    } catch (error) {
      console.warn('Failed to record mint:', error);
      // Non-critical error, mint was successful
    }

    return {
      success: true,
      signature: signature,
      explorerUrl: `https://solscan.io/tx/${signature}`
    };

  } catch (error) {
    console.error('Error minting NFT:', error);
    throw error;
  }
};

// Helper: Confirm transaction
const confirmTransaction = async (signature, maxAttempts = 30) => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${BACKEND_URL}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature]]
        })
      });

      const data = await response.json();
      const status = data.result?.value?.[0];

      if (status) {
        if (status.confirmationStatus === 'confirmed' || 
            status.confirmationStatus === 'finalized') {
          return true;
        }
        if (status.err) {
          throw new Error('Transaction failed: ' + JSON.stringify(status.err));
        }
      }

      // Wait 2 seconds before next attempt
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      if (i === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw new Error('Transaction confirmation timeout');
};

// Example React component usage
export const MintButton = () => {
  const [wallet, setWallet] = useState(null);
  const [eligible, setEligible] = useState(null);
  const [minting, setMinting] = useState(false);
  const [status, setStatus] = useState('');

  const handleConnect = async () => {
    try {
      const address = await connectWallet();
      setWallet(address);
      
      // Check eligibility
      const eligibilityResult = await checkEligibility(address);
      setEligible(eligibilityResult);
      
      if (eligibilityResult.eligible) {
        setStatus('Ready to mint!');
      } else {
        setStatus(eligibilityResult.reason);
      }
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  };

  const handleMint = async () => {
    if (!wallet || !eligible?.eligible) return;

    setMinting(true);
    setStatus('Minting...');

    try {
      const result = await mintNFT(wallet);
      setStatus('Mint successful! View on Solscan: ' + result.explorerUrl);
    } catch (error) {
      setStatus('Mint failed: ' + error.message);
    } finally {
      setMinting(false);
    }
  };

  return (
    <div>
      {!wallet ? (
        <button onClick={handleConnect}>Connect Phantom Wallet</button>
      ) : (
        <div>
          <p>Wallet: {wallet}</p>
          <button 
            onClick={handleMint} 
            disabled={!eligible?.eligible || minting}
          >
            {minting ? 'Minting...' : 'Mint FUNDOSHI NFT'}
          </button>
        </div>
      )}
      {status && <p>{status}</p>}
    </div>
  );
};
