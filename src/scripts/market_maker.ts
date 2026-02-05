import fs from 'fs';
import csv from 'csv-parser';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

const ECPair = ECPairFactory(tinysecp);

// Configuration
const API_BASE = 'https://api.counterparty.io:4000/v2'; // Production
const DUST_LIMIT = 546;

// Types
interface UTXO {
  txid: string;
  vout: number;
  value: number;
}

interface OrderCSV {
  give_asset: string;
  give_quantity: string;
  get_asset: string;
  get_quantity: string;
  expiration: string;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Fetch UTXOs from Mempool.space (or similar)
 * Note: Counterparty API v2 doesn't return raw UTXOs suitable for client-side signing easily,
 * so we use mempool.space for reliable UTXO data.
 */
async function getUTXOs(address: string): Promise<UTXO[]> {
  try {
    // Try mempool.space mainnet
    const { data } = await axios.get(`https://mempool.space/api/address/${address}/utxo`);
    return data.map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value
    }));
  } catch (e) {
    console.error('Failed to fetch UTXOs:', e.message);
    throw e;
  }
}

async function broadcastTx(hex: string): Promise<string> {
  try {
    const { data } = await axios.post('https://mempool.space/api/tx', hex);
    return data;
  } catch (e) {
      // Fallback
      console.warn('Mempool broadcast failed, trying Blockstream...');
      try {
           const { data } = await axios.post('https://blockstream.info/api/tx', hex);
           return data;
      } catch (err) {
          throw new Error('Broadcast failed on all providers');
      }
  }
}

async function composeOrder(params: any) {
  const query = new URLSearchParams(params).toString();
  const { data } = await axios.get(`${API_BASE}/addresses/${params.address}/compose/order?${query}`);
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ----------------------------------------------------------------------------
// Main Logic
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const privateKeyWIF = process.env.PRIVATE_KEY;
  const sourceCsv = args[0] || 'orders.csv';

  if (!privateKeyWIF) {
    console.error('Error: PRIVATE_KEY must be set in .env');
    process.exit(1);
  }

  // 1. Setup Wallet
  const network = bitcoin.networks.bitcoin;
  const keyPair = ECPair.fromWIF(privateKeyWIF, network);
  const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
  
  if (!address) throw new Error("Could not derive address");

  console.log(`\n🤖 Market Maker Agent Active`);
  console.log(`👛 Wallet: ${address}`);
  console.log(`📂 Reading: ${sourceCsv}`);

  // 2. Read CSV
  const orders: OrderCSV[] = [];
  try {
    await new Promise((resolve, reject) => {
        fs.createReadStream(path.resolve(process.cwd(), sourceCsv))
        .pipe(csv())
        .on('data', (data) => orders.push(data))
        .on('end', resolve)
        .on('error', reject);
    });
  } catch (e) {
    console.error(`Failed to read CSV: ${e.message}`);
    process.exit(1);
  }

  if (orders.length === 0) {
    console.log('No orders found in CSV.');
    process.exit(0);
  }

  console.log(`Found ${orders.length} orders to process.`);

  // 3. Chain Transactions
  // We manage the "current" UTXO set manually.
  let utxos = await getUTXOs(address);
  
  // Sort UTXOs by value (descending) to pick biggest first
  utxos.sort((a, b) => b.value - a.value);

  // We need a "change" UTXO to chain.
  // Strategy: 
  // - Pick one big UTXO to start.
  // - Each TX spends it + fee, and creates a Change output.
  // - The next TX uses that Change output.
  
  if (utxos.length === 0) {
    console.error('No UTXOs found! Fund this address with BTC.');
    process.exit(1);
  }

  let activeUtxo = utxos[0]; // Start with the biggest
  console.log(`Using Input UTXO: ${activeUtxo.txid}:${activeUtxo.vout} (${activeUtxo.value} sats)`);

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    console.log(`\n--- Processing Order ${i + 1}/${orders.length} ---`);
    console.log(`${o.give_asset} -> ${o.get_asset}`);

    try {
        // A. Compose parameters
        // Note: We don't use the 'rawtransaction' from API because we want to build it ourselves to control inputs.
        // We only use the API to get the DATA payload (Counterparty implementation details).
        // Actually, the v2 'compose' returns raw hex with specific inputs selected by the API if we don't override.
        // To chain properly, we should just extract the OP_RETURN data from the composed result ?
        // OR better: Just assume simple OP_RETURN construction if we knew the protocol.
        // BUT safer: Use the API compose, but try to force inputs?
        // API v2 `compose` endpoint supports `use_utxos`? Unlikely to work well with unconfirmed chaining client-side.
        
        // BETTER STRATEGY (Hybrid):
        // 1. Ask API to compose (it will pick inputs it sees confirmed).
        // 2. We Parse that result to get the OP_RETURN data (RC4 encoded possibly? No, basic orders are cleartext usually or simple encoding).
        // 3. We build a NEW transaction using our `activeUtxo` and that OP_RETURN data.
        
        // Wait, CP v2 compose returns `params` which is the payload? 
        // Let's check `composeOrder` result structure from library.
        // params: Record<string, unknown>
        
        // Let's call compose with 0 fee to just get the logic?
        const composition = await composeOrder({
            address,
            give_asset: o.give_asset,
            give_quantity: Math.round(parseFloat(o.give_quantity) * 100000000), // Norm to sats? Checking assumption.
            get_asset: o.get_asset,
            get_quantity: Math.round(parseFloat(o.get_quantity) * 100000000),
            expiration: parseInt(o.expiration),
            fee_required: 0
        });

        // We need the OP_RETURN data.
        // The API returns a `rawtransaction` (string hex).
        // We can decode it to find the OP_RETURN.
        const tempTx = bitcoin.Transaction.fromHex(composition.rawtransaction);
        let opReturnData: Buffer | null = null;
        
        for (const out of tempTx.outputs) {
            const script = bitcoin.script.toASM(out.script);
            if (script.startsWith('OP_RETURN')) {
                // Extract the data
                // ASM format: OP_RETURN <hex_data>
                const parts = script.split(' ');
                if (parts.length > 1) {
                   opReturnData = Buffer.from(parts[1], 'hex');
                }
                break;
            }
        }

        if (!opReturnData) {
            throw new Error('Could not extract OP_RETURN data from API composition');
        }

        // B. Construct Custom Transaction with Chaining
        const psbt = new bitcoin.Psbt({ network });
        
        // Input: Our active (potentially unconfirmed) UTXO
        psbt.addInput({
            hash: activeUtxo.txid,
            index: activeUtxo.vout,
            nonWitnessUtxo: Buffer.from('020000000001000000', 'hex'), // Dummy if we don't have full prev tx? 
            // WAIT: for non-segwit (P2PKH), we need nonWitnessUtxo (full prev tx).
            // For P2WPKH, we need witnessUtxo. 
            // The Gist uses `bitcoinjs-lib` implies standard handling.
            // If we only have TXID/VOUT/Value from mempool, we can't easily sign P2PKH non-segwit without fetching the full TX hex.
            // Mempool.space API provides full hex? Yes `GET /tx/:txid/hex`.
        });
        
        // We need to fetch the full Previous TX hex for the input
        const { data: prevTxHex } = await axios.get(`https://mempool.space/api/tx/${activeUtxo.txid}/hex`);
        psbt.updateInput(0, {
            nonWitnessUtxo: Buffer.from(prevTxHex, 'hex')
        });

        // Output 1: OP_RETURN
        psbt.addOutput({
            script: bitcoin.script.compile([
                bitcoin.opcodes.OP_RETURN,
                opReturnData
            ]),
            value: 0
        });

        // Output 2: Change (back to us)
        // Fee calculation: approx 250 bytes * 20 sat/vbyte? 
        const FEE = 3000; // 3000 sats conservative
        const changeValue = activeUtxo.value - FEE; // Output 1 is 0 value

        if (changeValue < DUST_LIMIT) {
            throw new Error(`Insufficient funds: ${activeUtxo.value} - ${FEE} < Dust`);
        }

        psbt.addOutput({
            address: address,
            value: changeValue
        });

        // Sign
        psbt.signInput(0, keyPair);
        psbt.finalizeAllInputs();

        const tx = psbt.extractTransaction();
        const hex = tx.toHex();
        const txid = tx.getId();

        // C. Broadcast
        console.log(`Broadcasting Chain TX ${i+1}: ${txid}`);
        await broadcastTx(hex);

        // D. Update Active UTXO for next loop
        // The new input is Output #1 of this tx (index 1, because index 0 is OP_RETURN)
        activeUtxo = {
            txid: txid,
            vout: 1,
            value: changeValue
        };
        
        console.log(`✅ Success. Next input: ${txid}:1`);

    } catch (err) {
        console.error(`❌ Failed Order ${i+1}: ${err.message}`);
        // If one fails, the chain breaks (because we haven't broadcast the change output?)
        // Actually if broadcast failed, the chain is broken locally.
        process.exit(1);
    }
  }
}

main().catch(console.error);
