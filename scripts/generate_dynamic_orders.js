import fs from 'fs';

const address = "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j";

const FAUX_ASSETS = [
"FAUXCORNKING", "FAUXCORNCASH", "KERNELLIMITS", "KERNELISLAND", "RARECOB",
"CORNPIGEON", "INTOCORNLAND", "CORNYHOMER", "GRILLEDCORN", "CORNDEITY",
"CORNTAINER", "BITCORNHOLIO", "TRUTHBUDCORN", "NEVEREATCORN", "SOUTHCORN",
"CORNEATER", "CORNALIEN", "KERNELKEVIN", "BITCORNKING", "PREARRANGED",
"CORNSICKLE", "PAIKCORN", "CORNSNKESKL", "CORNNUTS", "FXCORNFARMER",
"KORNACHMED", "INCORNITO", "OFFDACORN", "SLOBONMYKNOB", "CORNFED",
"CORNQUEEN", "BITCORNQUER", "FAUXBANKSY", "CORNROLLIJET", "ETOLE",
"MRCORNPORATE", "CORNELYUNQUE", "CORNDARGER", "KRUSTYCORN", "TRANSFORMAS",
"FIELDOFCORN", "CORNMONGER", "GOGHCORNISH", "BURNEDCORN", "METALCORN",
"ISTHISAGRAIL", "FAULKCORN", "FAUXPOPWAVE", "FAUXARCHCORN", "CORNSROASTER",
"ONLYCANS", "XCPMADECORN", "CORNSQUIAT", "CORNSHARVEST", "CORNSENERGY",
"BUFFALOGAL", "LINECORN", "EDENFARM"
];

const TARGETS = ['PEPECASH', 'XCP', 'DANKMEMECASH'];

// Fixed Fallback values in base currency if an asset has NEVER traded against it.
// E.g. 1 Asset = 100 PEPECASH, 0.1 XCP, 10 DANKMEMECASH
const FALLBACK_PRICES = {
  'PEPECASH': 100,      // Ask 100 PEPECASH
  'XCP': 0.1,           // Ask 0.1 XCP
  'DANKMEMECASH': 10    // Ask 10 DANKMEMECASH
};

// Caches
const priceHistoryCache = {};
const divisibilityCache = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000); // Fast 3s timeout
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      
      if (res.ok) return res;
      
      // If we get 404 or something, the pair probably doesn't exist. Don't retry.
      if (res.status === 404 || res.status === 400 || res.status === 500) return null;
      
      await sleep(1000);
    } catch (e) {
      if (i === retries - 1) return null;
      await sleep(1000);
    }
  }
  return null;
}

async function getDivisibility(asset) {
  if (asset === 'XCP' || asset === 'BTC') return true;
  if (divisibilityCache.has(asset)) return divisibilityCache.get(asset);

  try {
    const res = await fetchWithRetry(`https://api.counterparty.io:4000/v2/assets/${asset}?verbose=true`);
    if (!res) return false;
    const data = await res.json();
    const info = Array.isArray(data) ? data[0] : (data.result?.[0] || data.result);
    // V2 api often returns `divisible`
    const isDiv = info ? !!info.divisible : false;
    divisibilityCache.set(asset, isDiv);
    return isDiv;
  } catch(e) {
    return false; // play it safe
  }
}

/**
 * Fetches the LAST MATCHED trade for Asset A / Asset B on Counterparty DEX.
 * Returns the price of 1 Unit of `asset` denominated in `quoteAsset`.
 */
async function getLastDexPrice(asset, quoteAsset) {
  const pairKey = `${asset}_${quoteAsset}`;
  if (priceHistoryCache[pairKey]) return priceHistoryCache[pairKey];

  try {
    const res = await fetchWithRetry(`https://api.counterparty.io:4000/v2/orders/${asset}/${quoteAsset}?status=filled&limit=1`);
    if (!res) {
        priceHistoryCache[pairKey] = null;
        return null;
    }
    const data = await res.json();
    const match = data.result?.[0];

    if (!match) {
        priceHistoryCache[pairKey] = null;
        return null; // No history
    }

    // `match` is an order. If `give_asset` == asset, it's a SELL order of the asset.
    // The price is straightforward but depends on divisibility. 
    // Usually the V2 api provides `market_price` directly which is Price of give_asset in terms of get_asset (or vice versa? It's Base/Quote).
    // Let's calculate manually to be absolutely certain of the math.

    const giveDiv = match.give_asset_divisible;
    const getDiv = match.get_asset_divisible;
    
    let giveQty = match.give_quantity;
    if (giveDiv) giveQty = giveQty / 100000000;

    let getQty = match.get_quantity;
    if (getDiv) getQty = getQty / 100000000;

    let priceOfAssetInQuote;
    if (match.give_asset === asset) {
        // We gave the asset, and got the quote.
        // Price = got / gave
        priceOfAssetInQuote = getQty / giveQty;
    } else {
        // We gave the quote, and got the asset.
        // Price = gave / got
        priceOfAssetInQuote = giveQty / getQty;
    }

    priceHistoryCache[pairKey] = priceOfAssetInQuote;
    return priceOfAssetInQuote;

  } catch (err) {
    console.error(`Error fetching price for ${asset}/${quoteAsset}:`, err.message);
    return null;
  }
}


async function generate() {
  console.log("Fetching balances...");
  let allBalances = [];
  let cursor = null;
  const baseUrl = `https://api.counterparty.io:4000/v2/addresses/${address}/balances?verbose=true`;

  while (true) {
    const res = await fetch(cursor ? `${baseUrl}&cursor=${cursor}` : baseUrl);
    if (!res.ok) break;
    const data = await res.json();
    const actualData = Array.isArray(data) ? data : (data.result || []);
    allBalances = allBalances.concat(actualData);
    if (data.next_cursor) cursor = data.next_cursor;
    else break;
  }

  const csvRows = [];
  csvRows.push("give_asset,give_quantity,get_asset,get_quantity,expiration");
  const expirationBlocks = 5000;

  // 1. Issuance Listing (ASKS)
  const issuedAssets = allBalances.filter(b => {
      const qtyNorm = parseFloat(b.quantity_normalized || 0);
      return b.asset_info && b.asset_info.issuer === address && qtyNorm > 10;
  });

  console.log(`\nPhase 1: Generating ASKS for ${issuedAssets.length} issued assets...`);
  
  // Batch processing function
  async function processBatch(items, processor, batchSize = 10) {
      for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          await Promise.all(batch.map(processor));
          await sleep(500); // Wait between batches
      }
  }

  await processBatch(issuedAssets, async (b) => {
      for (const quote of TARGETS) {
           let targetAmount = await getLastDexPrice(b.asset, quote);
           
           if (targetAmount) {
               console.log(`[DEX MATCH] ${b.asset}/${quote} last traded at ${targetAmount.toFixed(4)}. Using this price.`);
           } else {
               targetAmount = FALLBACK_PRICES[quote];
           }
           csvRows.push(`${b.asset},1,${quote},${targetAmount.toFixed(8).replace(/\\.?0+$/, '')},${expirationBlocks}`);
      }
  }, 5);

  // 2. FAUXBITCORN Bidding (BIDS)
  console.log(`\nPhase 2: Generating BIDS for ${FAUX_ASSETS.length} FAUXBITCORN assets...`);
  
  await processBatch(FAUX_ASSETS, async (faux) => {
      if(faux === 'FAUXCORNCASH' || faux === 'DANKROSECASH') return;
      
      const get_q_faux = "1"; 

      let [priceInDank, priceInFauxCash] = await Promise.all([
          getLastDexPrice(faux, 'DANKROSECASH'),
          getLastDexPrice(faux, 'FAUXCORNCASH')
      ]);
      
      if (priceInDank) {
         console.log(`[DEX MATCH] ${faux}/DANKROSECASH last traded at ${priceInDank}. Bidding 10% below market.`);
         priceInDank = priceInDank * 0.90;
      } else {
         priceInDank = 5000; 
      }

      if (priceInFauxCash) {
         console.log(`[DEX MATCH] ${faux}/FAUXCORNCASH last traded at ${priceInFauxCash}. Bidding 10% below market.`);
         priceInFauxCash = priceInFauxCash * 0.90;
      } else {
         priceInFauxCash = 50; 
      }

      csvRows.push(`DANKROSECASH,${priceInDank.toFixed(8).replace(/\\.?0+$/, '')},${faux},${get_q_faux},${expirationBlocks}`);
      csvRows.push(`FAUXCORNCASH,${priceInFauxCash.toFixed(8).replace(/\\.?0+$/, '')},${faux},${get_q_faux},${expirationBlocks}`);
  }, 5);

  fs.writeFileSync('fauxbitcorn_dynamic_orders.csv', csvRows.join('\n'));
  console.log(`\nGenerated 'fauxbitcorn_dynamic_orders.csv' with ${csvRows.length - 1} SAFE dynamic orders!`);
}

generate().catch(console.error);
