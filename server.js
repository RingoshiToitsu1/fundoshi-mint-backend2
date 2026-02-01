import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Metaplex } from '@metaplex-foundation/js';

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CANDY_MACHINE_ID = new PublicKey('3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ');
const RPC_ENDPOINT = 'https://solana-mainnet.gateway.tatum.io';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Load authority keypair from environment
let authorityKeypair;
try {
  const secretKey = JSON.parse(process.env.AUTHORITY_SECRET_KEY || '[]');
  if (secretKey.length !== 64) {
    throw new Error('Invalid authority secret key length');
  }
  authorityKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  console.log('✅ Authority keypair loaded:', authorityKeypair.publicKey.toBase58());
} catch (error) {
  console.error('❌ Failed to load authority keypair:', error.message);
  process.exit(1);
}

// Initialize Metaplex
const metaplex = Metaplex.make(connection);

// Middleware
app.use(cors());
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Helper functions
async function loadWhitelist() {
  try {
    const data = await fs.readFile('./whitelist.json', 'utf-8');
    const whitelist = JSON.parse(data);
    if (!Array.isArray(whitelist)) {
      console.error('⚠️ whitelist.json is not an array, returning empty array');
      return [];
    }
    return whitelist;
  } catch (error) {
    console.error('⚠️ Error loading whitelist:', error.message);
    return [];
  }
}

async function loadMinted() {
  try {
    const data = await fs.readFile('./minted.json', 'utf-8');
    const minted = JSON.parse(data);
    if (!Array.isArray(minted)) {
      console.error('⚠️ minted.json is not an array, returning empty array');
      return [];
    }
    return minted;
  } catch (error) {
    console.error('⚠️ Error loading minted, creating new file');
    await fs.writeFile('./minted.json', JSON.stringify([], null, 2));
    return [];
  }
}

async function saveMinted(minted) {
  if (!Array.isArray(minted)) {
    throw new Error('minted must be an array');
  }
  await fs.writeFile('./minted.json', JSON.stringify(minted, null, 2));
}

async function checkEligibility(wallet) {
  const whitelist = await loadWhitelist();
  const minted = await loadMinted();

  // Check if wallet is in whitelist
  const isWhitelisted = whitelist.includes(wallet);
  if (!isWhitelisted) {
    return { eligible: false, reason: 'Wallet not on whitelist' };
  }

  // Check if wallet has already minted
  const hasMinted = minted.includes(wallet);
  if (hasMinted) {
    return { eligible: false, reason: 'Wallet has already minted' };
  }

  return { eligible: true };
}

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'FUNDOSHI Mint Backend',
    status: 'online',
    candyMachine: CANDY_MACHINE_ID.toBase58(),
    authority: authorityKeypair.publicKey.toBase58(),
    endpoints: ['/mint/check', '/mint', '/rpc']
  });
});

// Check mint eligibility
app.post('/mint/check', async (req, res) => {
  try {
    const { wallet } = req.body;

    if (!wallet) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Validate wallet address
    let walletPubkey;
    try {
      walletPubkey = new PublicKey(wallet);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const eligibility = await checkEligibility(wallet);
    console.log(`Eligibility check for ${wallet}:`, eligibility);

    res.json(eligibility);
  } catch (error) {
    console.error('Error in /mint/check:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create mint transaction
app.post('/mint', async (req, res) => {
  try {
    const { wallet } = req.body;

    if (!wallet) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Validate wallet address
    let walletPubkey;
    try {
      walletPubkey = new PublicKey(wallet);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Check eligibility
    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(403).json({ error: eligibility.reason });
    }

    console.log(`Creating mint transaction for ${wallet}`);

    // Fetch Candy Machine
    const candyMachine = await metaplex.candyMachines().findByAddress({
      address: CANDY_MACHINE_ID
    });

    console.log('Candy Machine loaded:', {
      itemsAvailable: candyMachine.itemsAvailable.toString(),
      itemsMinted: candyMachine.itemsMinted.toString(),
      itemsRemaining: candyMachine.itemsRemaining.toString()
    });

    // Check if items are available
    if (candyMachine.itemsRemaining.toNumber() === 0) {
      return res.status(400).json({ error: 'All NFTs have been minted' });
    }

    // Build mint transaction
    const mintBuilder = await metaplex.candyMachines().builders().mint({
      candyMachine,
      collectionUpdateAuthority: authorityKeypair.publicKey,
      owner: walletPubkey,
    });

    // Convert to transaction
    const { signature, ...transaction } = await mintBuilder.toTransaction({
      blockhashWithExpiryBlockHeight: await connection.getLatestBlockhash()
    });

    // Set fee payer to user wallet
    transaction.feePayer = walletPubkey;

    // Partially sign with authority if needed
    // Note: Candy Machine v3 may require authority signature
    const signers = mintBuilder.getSigners();
    const authoritySigner = signers.find(s => s.publicKey.equals(authorityKeypair.publicKey));
    
    if (authoritySigner) {
      transaction.partialSign(authorityKeypair);
      console.log('✅ Transaction partially signed by authority');
    }

    // Serialize transaction for frontend
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    const base64Transaction = serializedTransaction.toString('base64');

    console.log(`✅ Mint transaction created for ${wallet}`);

    res.json({
      transaction: base64Transaction,
      message: 'Transaction ready for signing'
    });

  } catch (error) {
    console.error('Error in /mint:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// RPC proxy endpoint
app.post('/rpc', async (req, res) => {
  try {
    const rpcRequest = req.body;

    console.log(`RPC proxy: ${rpcRequest.method}`);

    // Forward request to Solana RPC
    const response = await fetch(RPC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rpcRequest)
    });

    const rpcResponse = await response.json();

    // Return raw response without modification
    res.json(rpcResponse);

  } catch (error) {
    console.error('Error in /rpc:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error.message
      },
      id: req.body.id || null
    });
  }
});

// Confirm mint endpoint (optional - can be called after successful mint)
app.post('/mint/confirm', async (req, res) => {
  try {
    const { wallet, signature } = req.body;

    if (!wallet || !signature) {
      return res.status(400).json({ error: 'Wallet and signature required' });
    }

    // Verify transaction was successful
    const confirmation = await connection.getSignatureStatus(signature);
    
    if (confirmation.value?.confirmationStatus === 'confirmed' || 
        confirmation.value?.confirmationStatus === 'finalized') {
      
      // Add wallet to minted list
      const minted = await loadMinted();
      if (!minted.includes(wallet)) {
        minted.push(wallet);
        await saveMinted(minted);
        console.log(`✅ Wallet ${wallet} recorded as minted`);
      }

      res.json({ 
        success: true, 
        message: 'Mint confirmed and recorded',
        signature 
      });
    } else {
      res.status(400).json({ 
        error: 'Transaction not confirmed',
        status: confirmation.value?.confirmationStatus 
      });
    }

  } catch (error) {
    console.error('Error in /mint/confirm:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 FUNDOSHI Mint Backend running on port ${PORT}`);
  console.log(`Candy Machine: ${CANDY_MACHINE_ID.toBase58()}`);
  console.log(`Authority: ${authorityKeypair.publicKey.toBase58()}`);
  console.log(`RPC: ${RPC_ENDPOINT}`);
});
