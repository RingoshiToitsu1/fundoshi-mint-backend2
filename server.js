import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

const CANDY_MACHINE_ID = '3pzu8qm6Hw65VH1khEtoU3ZPi8AtGn92oyjuUvVswArJ';

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

// Mint using Sugar CLI
app.post('/mint/sugar', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'Wallet required' });

    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(403).json({ error: eligibility.reason });
    }

    console.log(`Minting for ${wallet} using Sugar CLI...`);

    // Execute Sugar CLI mint command
    const command = `sugar mint --number 1 --receiver ${wallet}`;
    
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(), // Should have cache.json here
      timeout: 60000 // 60 second timeout
    });

    console.log('Sugar output:', stdout);
    if (stderr) console.error('Sugar stderr:', stderr);

    // Parse the mint address from output
    const mintMatch = stdout.match(/Mint: ([A-Za-z0-9]+)/);
    const signature = mintMatch ? mintMatch[1] : null;

    if (!signature) {
      throw new Error('Could not parse mint signature from Sugar output');
    }

    console.log('✅ Minted! Signature:', signature);

    // Record the mint
    const minted = await loadMinted();
    if (!minted.includes(wallet)) {
      minted.push(wallet);
      await saveMinted(minted);
    }

    res.json({
      success: true,
      signature: signature,
      solscan: `https://solscan.io/tx/${signature}`
    });

  } catch (error) {
    console.error('Sugar mint error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FUNDOSHI Mint Backend (Sugar CLI)',
    endpoints: ['/mint/check', '/mint/sugar'],
    candyMachine: CANDY_MACHINE_ID
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Using Sugar CLI for Candy Machine: ${CANDY_MACHINE_ID}`);
});
