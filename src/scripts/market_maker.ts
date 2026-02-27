import fs from 'node:fs';
import path from 'node:path';
import csv from 'csv-parser';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import dotenv from 'dotenv';

dotenv.config();

const ECPair = ECPairFactory(tinysecp);

const API_BASE = 'https://api.counterparty.io:4000/v2';
const DUST_LIMIT = 546;
const DEFAULT_FEE = 3000;
const MAX_MEMPOOL_TXS = 24; // Bitcoin Core default relay limit per address is 25

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

interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
}

interface CounterpartyComposeResult {
  rawtransaction: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function parsePositiveDecimal(value: string, label: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
  return parsed;
}

function toSats(value: string, label: string): number {
  return Math.round(parsePositiveDecimal(value, label) * 100000000);
}

function parseExpiration(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid expiration: "${value}"`);
  }
  return parsed;
}

function extractOpReturnData(rawTransaction: string): Buffer {
  const tx = bitcoin.Transaction.fromHex(rawTransaction);
  for (const out of tx.outs) {
    const chunks = bitcoin.script.decompile(out.script);
    if (!chunks || chunks.length < 2) continue;
    if (chunks[0] !== bitcoin.opcodes.OP_RETURN) continue;
    const opReturnPayload = chunks[1];
    if (Buffer.isBuffer(opReturnPayload)) {
      return opReturnPayload;
    }
  }
  throw new Error('Could not extract OP_RETURN payload from composed transaction');
}

async function getUTXOsWithBalances(address: string): Promise<Set<string>> {
  const utxos = new Set<string>();
  try {
    const { data } = await axios.get(`${API_BASE}/addresses/${address}/balances?type=utxo&verbose=false`);
    for (const b of (data.result || [])) {
      if (b.utxo) utxos.add(b.utxo);
    }
  } catch {
    console.warn("Failed to fetch UTXO balances for exclusion, proceeding cautiously...");
  }
  return utxos;
}

async function getUTXOs(address: string): Promise<UTXO[]> {
  try {
    const { data } = await axios.get<MempoolUtxo[]>(
      `https://mempool.space/api/address/${address}/utxo`,
    );
    const utxosWithBalances = await getUTXOsWithBalances(address);

    return data
      .filter(u => !utxosWithBalances.has(`${u.txid}:${u.vout}`))
      .map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
      }));
  } catch (error) {
    console.error('Failed to fetch UTXOs:', getErrorMessage(error));
    throw error;
  }
}

async function getPrevTxHex(txid: string): Promise<string> {
  const { data } = await axios.get<string>(`https://mempool.space/api/tx/${txid}/hex`);
  return data;
}

async function broadcastTx(hex: string): Promise<string> {
  const headers = { 'Content-Type': 'text/plain' };
  try {
    const { data } = await axios.post<string>('https://mempool.space/api/tx', hex, { headers });
    return data;
  } catch {
    console.warn('Mempool broadcast failed, trying Blockstream...');
    const { data } = await axios.post<string>('https://blockstream.info/api/tx', hex, { headers });
    return data;
  }
}

async function getExistingOpenOrders(address: string): Promise<Set<string>> {
  const existing = new Set<string>();
  try {
    const { data } = await axios.get(`${API_BASE}/addresses/${address}/orders?status=open&show_unconfirmed=true`);
    for (const order of (data.result || [])) {
      existing.add(`${order.give_asset}:${order.get_asset}`);
    }
  } catch {
    console.warn("Failed to fetch existing open orders, skipping idempotency check.");
  }
  return existing;
}

async function getUnconfirmedTxCount(address: string): Promise<number> {
  try {
    const { data } = await axios.get(`https://mempool.space/api/address/${address}/txs`);
    return data.filter((tx: { status?: { confirmed?: boolean } }) => !tx.status?.confirmed).length;
  } catch {
    console.warn("Error getting unconfirmed tx count");
    return 0;
  }
}

async function composeOrder(params: {
  address: string;
  give_asset: string;
  give_quantity: number;
  get_asset: string;
  get_quantity: number;
  expiration: number;
  fee_required: number;
}): Promise<CounterpartyComposeResult> {
  const query = new URLSearchParams({
    give_asset: params.give_asset,
    give_quantity: params.give_quantity.toString(),
    get_asset: params.get_asset,
    get_quantity: params.get_quantity.toString(),
    expiration: params.expiration.toString(),
    fee_required: params.fee_required.toString(),
    allow_unconfirmed_inputs: 'true',
    exclude_utxos_with_balances: 'true'
  }).toString();

  const { data } = await axios.get<{ result?: CounterpartyComposeResult; error?: string }>(
    `${API_BASE}/addresses/${params.address}/compose/order?${query}`,
  );

  if (data.error) throw new Error(data.error);
  if (!data.result?.rawtransaction) {
    throw new Error('Counterparty compose API did not return rawtransaction');
  }
  return data.result;
}

async function readOrders(csvPath: string): Promise<OrderCSV[]> {
  return new Promise<OrderCSV[]>((resolve, reject) => {
    const orders: OrderCSV[] = [];

    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row: Record<string, string>) => {
        if (!row.give_asset || !row.get_asset || !row.give_quantity || !row.get_quantity || !row.expiration) {
          return;
        }
        orders.push({
          give_asset: row.give_asset.trim().toUpperCase(),
          give_quantity: row.give_quantity.trim(),
          get_asset: row.get_asset.trim().toUpperCase(),
          get_quantity: row.get_quantity.trim(),
          expiration: row.expiration.trim(),
        });
      })
      .on('end', () => resolve(orders))
      .on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const privateKeyWIF = process.env.PRIVATE_KEY;
  const sourceCsv = args[0] || 'orders.csv';

  if (!privateKeyWIF) {
    console.error('Error: PRIVATE_KEY must be set in .env');
    process.exit(1);
  }

  const network = bitcoin.networks.bitcoin;
  const keyPair = ECPair.fromWIF(privateKeyWIF, network);
  const payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
  const address = payment.address;

  if (!address) {
    throw new Error('Could not derive a wallet address from PRIVATE_KEY');
  }

  const csvPath = path.resolve(process.cwd(), sourceCsv);

  console.log('\nMarket Maker Agent Active [OPTIMIZED]');
  console.log(`Wallet: ${address}`);
  console.log(`Reading: ${csvPath}`);

  const orders = await readOrders(csvPath);
  if (orders.length === 0) {
    console.log('No valid orders found in CSV.');
    process.exit(0);
  }

  console.log(`Found ${orders.length} target orders in CSV.`);

  const utxos = await getUTXOs(address);
  utxos.sort((a, b) => b.value - a.value);

  if (utxos.length === 0) {
    throw new Error('No safe UTXOs found. Fund this address with BTC first.');
  }

  let activeUtxo = utxos[0];
  console.log(
    `Seeding Chain using Base UTXO: ${activeUtxo.txid}:${activeUtxo.vout} (${activeUtxo.value} sats)`,
  );

  console.log('Fetching existing active orders for idempotency logic...');
  const existingOrders = await getExistingOpenOrders(address);
  console.log(`Found ${existingOrders.size} open orders currently active.`);

  let unconfirmedTxs = await getUnconfirmedTxCount(address);
  
  for (let i = 0; i < orders.length; i += 1) {
    const order = orders[i];
    const orderKey = `${order.give_asset}:${order.get_asset}`;
    
    console.log(`\n--- [${i + 1}/${orders.length}] ${order.give_asset} -> ${order.get_asset} ---`);
    
    if (existingOrders.has(orderKey)) {
        console.log(`SKIP: Order pair already exists on DEX. Idempotency active.`);
        continue;
    }

    // Mempool Check
    while(unconfirmedTxs >= MAX_MEMPOOL_TXS) {
        console.log(`[MEMPOOL LIMIT] Waiting for transactions to confirm (${unconfirmedTxs}/${MAX_MEMPOOL_TXS}). Sleeping 30s...`);
        await sleep(30000);
        unconfirmedTxs = await getUnconfirmedTxCount(address);
    }

    try {
      const composition = await composeOrder({
        address,
        give_asset: order.give_asset,
        give_quantity: toSats(order.give_quantity, 'give_quantity'),
        get_asset: order.get_asset,
        get_quantity: toSats(order.get_quantity, 'get_quantity'),
        expiration: parseExpiration(order.expiration),
        fee_required: 0,
      });

      const opReturnData = extractOpReturnData(composition.rawtransaction);
      const prevTxHex = await getPrevTxHex(activeUtxo.txid);

      const psbt = new bitcoin.Psbt({ network });
      psbt.addInput({
        hash: activeUtxo.txid,
        index: activeUtxo.vout,
        nonWitnessUtxo: Buffer.from(prevTxHex, 'hex'),
      });

      psbt.addOutput({
        script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, opReturnData]),
        value: 0n,
      });

      const changeValue = activeUtxo.value - DEFAULT_FEE;
      if (changeValue < DUST_LIMIT) {
        throw new Error(
          `Insufficient funds for fee chain: ${activeUtxo.value} - ${DEFAULT_FEE} < ${DUST_LIMIT}`,
        );
      }

      psbt.addOutput({
        address,
        value: BigInt(changeValue),
      });

      psbt.signInput(0, keyPair);
      psbt.finalizeAllInputs();

      const tx = psbt.extractTransaction();
      const hex = tx.toHex();
      const txid = tx.getId();

      console.log(`Broadcasting chained tx: ${txid}`);
      await broadcastTx(hex);

      // Track the loop vars
      existingOrders.add(orderKey);
      unconfirmedTxs++;

      // Chain the unconfirmed change output directly into the next transaction
      activeUtxo = {
        txid,
        vout: 1, // Change is predictably at index 1 because OP_RETURN is index 0
        value: changeValue,
      };
      
      console.log(`Success! Next chained input set to: ${txid}:1`);
      
      // Delay strictly to prevent rate limiting 429s from our nodes
      await sleep(2000);
      
    } catch (error) {
      console.error(`Failed order block: ${getErrorMessage(error)}`);
      // If we fail mid-chain, it might be due to a stuck node. 
      // We can exit 1 cleanly, and user can just re-run since it's idempotent.
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
