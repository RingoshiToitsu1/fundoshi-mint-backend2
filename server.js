import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';

const app = express();
const PORT = process.env.PORT || 3000;

const CANDY_MACHINE_ID = new PublicKey('3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ');
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=0267bb20-16b0-42e9-a5f0-c0c0f0858502';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

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

// Setup Metaplex with authority as identity
const metaplex = Metaplex.make(connection)
  .use(keypairIdentity(authorityKeypair));

console.log('✅ Metaplex initialized for Candy Machine V2');

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

// Mint using Metaplex JS SDK for Candy Machine V2
app.post('/mint/v2', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'Wallet required' });

    const walletPubkey = new PublicKey(wallet);

    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(403).json({ error: eligibility.reason });
    }

    console.log(`Minting for ${wallet} using CM V2...`);

    // Fetch candy machine (V2)
    const candyMachine = await metaplex.candyMachines().findByAddress({
      address: CANDY_MACHINE_ID
    });

    console.log(`CM V2: ${candyMachine.itemsMinted}/${candyMachine.itemsAvailable} minted`);

    if (candyMachine.itemsRemaining.isZero()) {
      return res.status(400).json({ error: 'All NFTs minted' });
    }

    // Mint NFT - Metaplex handles everything
    const { nft, response } = await metaplex.candyMachines().mint({
      candyMachine,
      owner: walletPubkey,
      collectionUpdateAuthority: authorityKeypair.publicKey,
    });

    console.log('✅ Minted! Signature:', response.signature);

    // Record the mint
    const minted = await loadMinted();
    if (!minted.includes(wallet)) {
      minted.push(wallet);
      await saveMinted(minted);
    }

    res.json({
      success: true,
      signature: response.signature,
      nft: nft.address.toBase58(),
      solscan: `https://solscan.io/tx/${response.signature}`
    });

  } catch (error) {
    console.error('V2 mint error:', error);
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
    name: 'FUNDOSHI Mint Backend (Candy Machine V2)',
    endpoints: ['/mint/check', '/mint/v2', '/rpc'],
    candyMachine: CANDY_MACHINE_ID.toBase58(),
    version: 'V2'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Candy Machine V2: ${CANDY_MACHINE_ID.toBase58()}`);
});
