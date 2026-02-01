import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { 
  fetchCandyMachine,
  mintV2,
  mplCandyMachine
} from '@metaplex-foundation/mpl-candy-machine';
import {
  generateSigner,
  transactionBuilder,
  publicKey,
  some,
  sol
} from '@metaplex-foundation/umi';
import { createSignerFromKeypair, signerIdentity } from '@metaplex-foundation/umi';
import { Connection, Keypair, PublicKey as SolanaPublicKey } from '@solana/web3.js';

const app = express();
const PORT = process.env.PORT || 3000;

const CANDY_MACHINE_ADDRESS = '3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=0267bb20-16b0-42e9-a5f0-c0c0f0858502';

// Load authority keypair
let authorityKeypair;
try {
  const secretKey = JSON.parse(process.env.AUTHORITY_SECRET_KEY || '[]');
  authorityKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  console.log('✅ Authority:', authorityKeypair.publicKey.toBase58());
} catch (error) {
  console.error('❌ Failed to load authority');
  process.exit(1);
}

// Create Umi instance
const umi = createUmi(RPC_ENDPOINT).use(mplCandyMachine());

// Convert Solana Keypair to Umi keypair and set as signer
const umiKeypair = umi.eddsa.createKeypairFromSecretKey(authorityKeypair.secretKey);
const authoritySigner = createSignerFromKeypair(umi, umiKeypair);
umi.use(signerIdentity(authoritySigner));

console.log('✅ Umi initialized with authority');

// Also keep regular Solana connection for RPC proxy
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

app.use(cors());
app.use(express.json());

// Helper functions
async function loadWhitelist() {
  try {
    const data = await fs.readFile('./whitelist.json', 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

async function loadMinted() {
  try {
    const data = await fs.readFile('./minted.json', 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

async function saveMinted(minted) {
  await fs.writeFile('./minted.json', JSON.stringify(minted, null, 2));
}

async function checkEligibility(wallet) {
  const whitelist = await loadWhitelist();
  const minted = await loadMinted();

  if (!whitelist.includes(wallet)) {
    return { eligible: false, reason: 'Wallet not on whitelist' };
  }

  if (minted.includes(wallet)) {
    return { eligible: false, reason: 'Wallet has already minted' };
  }

  return { eligible: true };
}

app.post('/mint/check', async (req, res) => {
  try {
    const { wallet } = req.body;
    const eligibility = await checkEligibility(wallet);
    res.json(eligibility);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mint using Umi with MintV2 - NO GUARD
app.post('/mint/noguard', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'Wallet required' });

    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(403).json({ error: eligibility.reason });
    }

    console.log(`Minting for ${wallet} WITHOUT guard...`);

    const candyMachineAddress = publicKey(CANDY_MACHINE_ADDRESS);
    const candyMachine = await fetchCandyMachine(umi, candyMachineAddress);

    console.log(`CM: ${candyMachine.itemsRedeemed}/${candyMachine.data.itemsAvailable}`);

    if (candyMachine.itemsRedeemed >= candyMachine.data.itemsAvailable) {
      return res.status(400).json({ error: 'All NFTs minted' });
    }

    const nftMint = generateSigner(umi);
    const ownerPublicKey = publicKey(wallet);

    // Try minting WITHOUT specifying candy guard at all
    const mintIx = await mintV2(umi, {
      candyMachine: candyMachineAddress,
      nftMint,
      collectionMint: candyMachine.collectionMint,
      collectionUpdateAuthority: candyMachine.authority,
      payer: authoritySigner,
      minter: ownerPublicKey,
      // NO candyGuard parameter
      // NO group parameter
    });

    const tx = await mintIx.sendAndConfirm(umi);
    console.log('✅ Minted!', Buffer.from(tx.signature).toString('base64'));

    const minted = await loadMinted();
    if (!minted.includes(wallet)) {
      minted.push(wallet);
      await saveMinted(minted);
    }

    const sig = Buffer.from(tx.signature).toString('base64');
    res.json({
      success: true,
      signature: sig,
      nft: nftMint.publicKey,
      solscan: `https://solscan.io/tx/${sig}`
    });

  } catch (error) {
    console.error('No-guard mint error:', error);
    res.status(500).json({ 
      error: error.message,
      hint: 'Your Candy Machine may be misconfigured. Check mintAuthority on Solscan.'
    });
  }
});

// Mint using Umi with MintV2
app.post('/mint/umi', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'Wallet required' });

    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(403).json({ error: eligibility.reason });
    }

    console.log(`Minting for ${wallet} using Umi + MintV2...`);

    // Fetch candy machine
    const candyMachineAddress = publicKey(CANDY_MACHINE_ADDRESS);
    const candyMachine = await fetchCandyMachine(umi, candyMachineAddress);

    console.log(`Candy Machine: ${candyMachine.itemsRedeemed}/${candyMachine.data.itemsAvailable} minted`);
    console.log(`Candy Guard:`, candyMachine.mintAuthority);

    if (candyMachine.itemsRedeemed >= candyMachine.data.itemsAvailable) {
      return res.status(400).json({ error: 'All NFTs minted' });
    }

    // Generate NFT mint signer
    const nftMint = generateSigner(umi);

    // Convert wallet address to Umi public key
    const ownerPublicKey = publicKey(wallet);

    // Build mint instruction
    // Check if candy machine has a guard
    const mintArgs = {
      candyMachine: candyMachineAddress,
      nftMint,
      collectionMint: candyMachine.collectionMint,
      collectionUpdateAuthority: candyMachine.authority,
      payer: authoritySigner,
      minter: ownerPublicKey,
    };

    // Add candy guard if it exists
    if (candyMachine.mintAuthority && candyMachine.mintAuthority.__option === 'Some') {
      mintArgs.candyGuard = candyMachine.mintAuthority.value;
      mintArgs.group = some('default');
      console.log('Using candy guard:', candyMachine.mintAuthority.value);
    }

    // Create mint instruction using MintV2
    const mintIx = await mintV2(umi, mintArgs);

    // Build and send transaction
    const tx = await mintIx.sendAndConfirm(umi);

    console.log('✅ Minted! Signature:', tx.signature);

    // Convert signature to base58
    const signatureBase58 = Buffer.from(tx.signature).toString('base64');
    
    // Record the mint
    const minted = await loadMinted();
    if (!minted.includes(wallet)) {
      minted.push(wallet);
      await saveMinted(minted);
    }

    res.json({
      success: true,
      signature: signatureBase58,
      nft: nftMint.publicKey,
      solscan: `https://solscan.io/tx/${signatureBase58}`
    });

  } catch (error) {
    console.error('Umi mint error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

// RPC proxy
app.post('/rpc', async (req, res) => {
  try {
    const response = await fetch(RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    
    if (req.body.method === 'sendTransaction') {
      if (data.result) {
        console.log(`✅ TX: https://solscan.io/tx/${data.result}`);
      } else if (data.error) {
        console.log(`❌ TX failed:`, data.error);
      }
    }
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FUNDOSHI Mint Backend (Umi)',
    endpoints: ['/mint/check', '/mint/umi', '/rpc'],
    candyMachine: CANDY_MACHINE_ADDRESS
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Umi server running on port ${PORT}`);
  console.log(`Candy Machine: ${CANDY_MACHINE_ADDRESS}`);
});
