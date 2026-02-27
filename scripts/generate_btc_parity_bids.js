import fs from 'fs';

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 8000); 
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      
      if (res.ok) return res;
      if (res.status === 404 || res.status === 400 || res.status === 500) return null;
      await sleep(1000);
    } catch (e) {
      if (i === retries - 1) return null;
      await sleep(1000);
    }
  }
  return null;
}

/**
 * Searches for the lowest Dispenser price for a given asset.
 * Dispenser prices are natively defined in Satoshis.
 */
async function getLowestDispenserSatPrice(asset) {
  try {
    const res = await fetchWithRetry(`https://api.counterparty.io:4000/v2/dispensers?status=0`);
    if(!res) return null;
    const data = await res.json();
    const dispensers = (data.result || []).filter(d => d.asset === asset);
    
    if (dispensers.length === 0) {
       return null;
    }

    let lowestRate = Infinity;
    for (const d of dispensers) {
      // Calculate the price of 1 token in satoshis
      const rate = d.satoshirate / d.give_quantity;
      if (rate > 0 && rate < lowestRate) {
        lowestRate = rate;
      }
    }
    
    return lowestRate;
  } catch(e) {
    return null;
  }
}

async function getLowestAskSatPrice(asset) {
   // Check DEX for lowest active BTC ask
   try {
     const res = await fetchWithRetry(`https://api.counterparty.io:4000/v2/orders/${asset}/BTC?status=open`);
     if(!res) return null;
     const data = await res.json();
     const orders = data.result || [];
     
     let lowestAsk = Infinity;
     for(const o of orders) {
       if (o.give_asset === asset) {
          // It's an ask. They give asset, get BTC
          const price = o.get_quantity / o.give_quantity; // sats per unit
          if (price < lowestAsk) lowestAsk = price;
       }
     }
     if (lowestAsk !== Infinity) return lowestAsk;
     return null;
   } catch(e) {
     return null;
   }
}

async function generate() {
  console.log("Analyzing Dispenser Base Prices...");

  // 1. Find the floor price of FAUXCORNCASH in BTC (Sats)
  let fauxcornSats = await getLowestDispenserSatPrice("FAUXCORNCASH");
  
  if (!fauxcornSats) {
      console.log("[WARNING] No active dispenser for FAUXCORNCASH. Forcing 0.81235 sats (pulled from known txb23ee4a9078b54eacd3350a1539531a176c5e683692d3576cf0636d1e536ea65)");
      fauxcornSats = 0.81235;
  } else {
      console.log(`[DATA] FAUXCORNCASH is currently dispensed at ~${fauxcornSats.toFixed(4)} satoshis per token.`);
  }

  const csvRows = [];
  csvRows.push("give_asset,give_quantity,get_asset,get_quantity,expiration");
  const expirationBlocks = 5000;

  const FALLBACK_CARD_SATS = 10000; // 10,000 sats (~$10) fallback

  console.log(`\nGenerating Parity Bids for ${FAUX_ASSETS.length} FAUXBITCORN assets...`);
  
  // Batch processing function
  async function processBatch(items, processor, batchSize = 10) {
      for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          await Promise.all(batch.map(processor));
          await sleep(500); 
      }
  }

  await processBatch(FAUX_ASSETS, async (faux) => {
      if(faux === 'FAUXCORNCASH' || faux === 'DANKROSECASH') return;
      
      let cardSats = await getLowestDispenserSatPrice(faux);
      let source = "Active Dispenser";
      
      if (!cardSats) {
         cardSats = await getLowestAskSatPrice(faux);
         source = "Active DEX Ask";
      }

      if (!cardSats) {
         cardSats = FALLBACK_CARD_SATS;
         source = "Fallback ($10 roughly)";
      }

      // Calculate translation
      // To buy 1 CARD, we must give (Card Sats) / (Fauxcorn Sats)
      let fauxcornOffer = cardSats / fauxcornSats;

      // Ensure we bid mathematically exact or slightly better (round up giving if we want to secure it, but round down so we don't overpay). 
      // Actually we are matching the floor. Let's just use exact mathematical parity.
      
      console.log(`[PARITY] ${faux} -> ${cardSats.toFixed(0)} sats (${source}). Offering ${fauxcornOffer.toFixed(2)} FAUXCORNCASH.`);

      csvRows.push(`FAUXCORNCASH,${fauxcornOffer.toFixed(4).replace(/\\.?0+$/, '')},${faux},1,${expirationBlocks}`);
  }, 10);

  fs.writeFileSync('fauxbitcorn_parity_bids.csv', csvRows.join('\n'));
  console.log(`\nGenerated 'fauxbitcorn_parity_bids.csv' with ${csvRows.length - 1} exact Parity Bids!`);
}

generate().catch(console.error);
