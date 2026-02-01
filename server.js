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
import nacl from 'tweetnacl';

const app = express();
const PORT = process.env.PORT || 3000;

// Transaction cache to store transaction data between /mint and /mint/sign calls
const transactionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Clean up expired cache entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of transactionCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      transactionCache.delete(key);
      console.log(`Cleaned up expired cache for ${key}`);
    }
  }
}, 60 * 1000);

// Configuration
const CANDY_MACHINE_ID = new PublicKey('3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ');
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://solana-mainnet.gateway.tatum.io';
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

// Create mint transaction (unsigned - user will sign first)
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

    console.log(`Creating UNSIGNED mint transaction for ${wallet}`);

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

    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Build mint instructions using Metaplex
    const transactionBuilder = await metaplex.candyMachines().builders().mint({
      candyMachine,
      collectionUpdateAuthority: authorityKeypair.publicKey,
      owner: walletPubkey,
    });

    // Create a new Transaction from the instructions
    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = walletPubkey;

    // Add all instructions from the builder
    const instructions = transactionBuilder.getInstructions();
    instructions.forEach(instruction => {
      transaction.add(instruction);
    });

    // Get signers from the builder (we'll store these for later)
    const signers = transactionBuilder.getSigners();
    
    // Filter and deduplicate backend signers - STORE FULL KEYPAIRS
    const backendSignersMap = new Map();
    for (const signer of signers) {
      if (!signer.publicKey.equals(walletPubkey)) {
        const pubkeyStr = signer.publicKey.toBase58();
        if (!backendSignersMap.has(pubkeyStr)) {
          if (signer.secretKey) {
            // Store the FULL signer object (Keypair), not just the public key
            backendSignersMap.set(pubkeyStr, signer);
          }
        }
      }
    }

    console.log(`Backend signers needed: ${backendSignersMap.size}`);
    // Safe logging - handle different signer structures
    const signerKeys = Array.from(backendSignersMap.values()).map(s => {
      if (s.publicKey && typeof s.publicKey.toBase58 === 'function') {
        return s.publicKey.toBase58();
      } else if (typeof s.toBase58 === 'function') {
        return s.toBase58();
      } else {
        return String(s);
      }
    });
    console.log('Backend signer keys:', signerKeys);

    // Store backend signers in cache for /mint/sign to use
    const cacheKey = wallet;
    transactionCache.set(cacheKey, {
      signers: Array.from(backendSignersMap.values()), // Store full Keypair objects
      timestamp: Date.now()
    });
    console.log(`Cached ${backendSignersMap.size} signer(s) for ${cacheKey}`);

    // IMPORTANT: Compile the message to set up signature slots for ALL required signers
    // This ensures backend signers have slots even though we don't sign yet
    const message = transaction.compileMessage();
    
    // Add any backend signers that aren't already in the signature array
    for (const [pubkeyStr, signer] of backendSignersMap) {
      const pubkey = signer.publicKey;
      const alreadyInSigs = transaction.signatures.some(s => s.publicKey && s.publicKey.equals(pubkey));
      if (!alreadyInSigs) {
        transaction.signatures.push({
          signature: null,
          publicKey: pubkey
        });
        console.log(`Added signature slot for backend signer: ${pubkeyStr}`);
      }
    }

    console.log(`Transaction has ${transaction.signatures.length} signature slots`);

    // DO NOT sign here - send unsigned transaction
    // Serialize UNSIGNED transaction for frontend
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    const base64Transaction = serializedTransaction.toString('base64');
    
    console.log(`✅ UNSIGNED transaction created (${serializedTransaction.length} bytes)`);

    res.json({
      transaction: base64Transaction,
      message: 'Transaction ready for user signing'
    });

  } catch (error) {
    console.error('Error in /mint:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Sign transaction after user has signed
app.post('/mint/sign', async (req, res) => {
  try {
    const { wallet, transaction: userSignedTxBase64 } = req.body;

    if (!wallet || !userSignedTxBase64) {
      return res.status(400).json({ error: 'Wallet and transaction required' });
    }

    console.log(`Adding backend signatures for ${wallet}`);

    // Get cached signers from /mint call
    const cacheKey = wallet;
    const cachedData = transactionCache.get(cacheKey);
    
    if (!cachedData) {
      return res.status(400).json({ 
        error: 'Transaction expired or not found. Please request a new mint transaction.' 
      });
    }

    const backendSigners = cachedData.signers;
    console.log(`Retrieved ${backendSigners.length} cached signer(s) for ${cacheKey}`);
    
    // Debug: Check structure of cached signers
    backendSigners.forEach((s, i) => {
      console.log(`Cached signer ${i}:`, {
        type: s.constructor?.name,
        hasPublicKey: !!s.publicKey,
        hasSecretKey: !!s.secretKey,
        publicKeyType: s.publicKey?.constructor?.name
      });
    });

    // Deserialize user-signed transaction
    const userSignedTx = Transaction.from(Buffer.from(userSignedTxBase64, 'base64'));
    
    console.log('User-signed transaction received:');
    const initialSigs = userSignedTx.signatures.map(s => ({
      pubkey: s.publicKey.toBase58(),
      hasSig: s.signature !== null
    }));
    console.log('Initial signatures:', JSON.stringify(initialSigs, null, 2));

    console.log(`Will sign with ${backendSigners.length} backend signer(s):`);
    backendSigners.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.publicKey.toBase58()}`);
    });

    // Add backend signatures MANUALLY instead of using partialSign
    if (backendSigners.length > 0) {
      try {
        // DON'T recompile - use the existing serialized transaction to get the message
        // Recompiling causes "unknown signer" errors
        const txBuffer = Buffer.from(userSignedTxBase64, 'base64');
        
        // The message starts after the signature count (1 byte) and all signatures (64 bytes each)
        const sigCount = txBuffer[0];
        const messageStart = 1 + (sigCount * 64);
        const messageBytes = txBuffer.slice(messageStart);
        
        console.log(`Transaction has ${sigCount} signature slots`);
        console.log(`Message starts at byte ${messageStart}, length: ${messageBytes.length}`);
        
        // Hash the message to verify we're signing the right thing
        const crypto = await import('crypto');
        const messageHash = crypto.createHash('sha256').update(messageBytes).digest('hex');
        console.log(`Message hash: ${messageHash.substring(0, 16)}...`);
        
        for (const signer of backendSigners) {
          const signerPubkey = signer.publicKey.toBase58();
          
          // Sign the message
          const signature = nacl.sign.detached(messageBytes, signer.secretKey);
          console.log(`  ✅ Created signature for ${signerPubkey}`);
          console.log(`  Signature (first 16 bytes): ${Buffer.from(signature).slice(0, 16).toString('hex')}`);
          
          // Find the signature slot for this signer
          const sigIndex = userSignedTx.signatures.findIndex(s => 
            s.publicKey.toBase58() === signerPubkey
          );
          
          if (sigIndex >= 0) {
            userSignedTx.signatures[sigIndex].signature = Buffer.from(signature);
            console.log(`  ✅ Added signature at index ${sigIndex}`);
          } else {
            console.log(`  ⚠️ No signature slot found for ${signerPubkey}, adding new slot`);
            userSignedTx.signatures.push({
              signature: Buffer.from(signature),
              publicKey: signer.publicKey
            });
          }
        }
        console.log('✅ Backend signatures added');
      } catch (signError) {
        console.error('❌ Error adding backend signatures:', signError.message);
        throw signError;
      }
    } else {
      console.log('⚠️ No backend signers found!');
    }

    // Log final signature state
    const finalSigs = userSignedTx.signatures.map(s => ({
      pubkey: s.publicKey.toBase58(),
      hasSig: s.signature !== null
    }));
    console.log('Final signatures:', JSON.stringify(finalSigs, null, 2));

    // Count signed vs unsigned
    const signedCount = userSignedTx.signatures.filter(s => s.signature !== null).length;
    const totalCount = userSignedTx.signatures.length;
    console.log(`Signature status: ${signedCount}/${totalCount} signed`);

    // DON'T filter signatures - Solana will handle null signatures for non-signer accounts
    // The message format requires all accounts in signatures array even if not all sign
    
    // Serialize with all signatures (including nulls for non-signers)
    try {
      const fullySigned = userSignedTx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });
      const fullySignedBase64 = fullySigned.toString('base64');
      
      console.log(`✅ Serialized transaction (${fullySigned.length} bytes) with ${signedCount} signatures`);

      // Clean up cache after successful signing
      transactionCache.delete(cacheKey);
      console.log(`Cleaned up cache for ${cacheKey}`);

      res.json({
        transaction: fullySignedBase64,
        message: 'Transaction fully signed'
      });
    } catch (serializeError) {
      console.error('Serialization error:', serializeError.message);
      res.status(500).json({ error: 'Failed to serialize transaction: ' + serializeError.message });
    }

  } catch (error) {
    console.error('Error in /mint/sign:', error);
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
