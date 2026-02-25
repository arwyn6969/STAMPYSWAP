const address = "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j";

async function fetchAllBalances() {
  let allBalances = [];
  let cursor = null;
  const baseUrl = `https://api.counterparty.io:4000/v2/addresses/${address}/balances?verbose=true`;

  while (true) {
    const url = cursor ? `${baseUrl}&cursor=${cursor}` : baseUrl;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
      break;
    }
    const data = await res.json();
    
    // The response could be wrapped in standard CP API format or raw.
    // Based on previous tool output, it might be { result: [...], next_cursor: ... }
    const actualData = Array.isArray(data) ? data : data.result;
    
    if (!actualData) {
        // If data itself is the array of balances and next_cursor is mixed in? No, valid JSON object.
        if (Array.isArray(data.result)) {
            allBalances = allBalances.concat(data.result);
        } else if (Array.isArray(data)) {
            // some endpoints return array directly
            allBalances = allBalances.concat(data);
        } else {
             // Let's assume the root object has an array under some key. But based on curl output, it starts with an array if no result key?
             // Wait, the curl output started with: a.arweave... so it was cut off.
             // Actually, the standard API v2 usually returns { result: [...] } or just the array if older API.
             // Let's just iterate over Object keys to find the array if `result` isn't there.
             let found = false;
             for (const key in data) {
                 if (Array.isArray(data[key])) {
                     allBalances = allBalances.concat(data[key]);
                     found = true;
                     break;
                 }
             }
             if (!found) {
                 if (data && typeof data === 'object' && Object.keys(data).length > 0) {
                     // Maybe it's not well-formed?
                     // Let's skip
                 }
             }
        }
    } else {
        allBalances = allBalances.concat(actualData);
    }

    if (data.next_cursor) {
      cursor = data.next_cursor;
    } else {
      break;
    }
  }

  // Sort by quantity_normalized (float)
  allBalances.sort((a, b) => {
    const qA = parseFloat(a.quantity_normalized || 0);
    const qB = parseFloat(b.quantity_normalized || 0);
    return qB - qA; // Descending
  });
  
  // Filter out zero balances just in case
  allBalances = allBalances.filter(a => parseFloat(a.quantity_normalized || 0) > 0);

  const totalAssets = allBalances.length;
  const top10PercentCount = Math.max(1, Math.floor(totalAssets * 0.10));
  const topAssets = allBalances.slice(0, top10PercentCount);

  console.log(`Total non-zero assets: ${totalAssets}`);
  console.log(`Selecting top 10% (${top10PercentCount} assets) by circulating supply in the wallet:`);
  console.log('---------------------------------------------------------');
  topAssets.forEach((b, i) => {
    console.log(`${i + 1}. ${b.asset} - ${b.quantity_normalized}`);
  });
}

fetchAllBalances().catch(console.error);
