const API_BASE = 'https://api.counterparty.io:4000/v2';

async function fetchOrders(asset) {
  const res = await fetch(`${API_BASE}/assets/${asset}/orders?status=open&verbose=true`);
  const data = await res.json();
  return data.result || [];
}

async function main() {
  const fauxOrders = await fetchOrders('FAUXCORNCASH');
  const dankOrders = await fetchOrders('DANKROSECASH');

  console.log(`Open orders for FAUXCORNCASH: ${fauxOrders.length}`);
  console.log(`Open orders for DANKROSECASH: ${dankOrders.length}`);
  
  // Find common pairs or direct markets
  const fauxPairs = new Set(fauxOrders.map(o => o.give_asset === 'FAUXCORNCASH' ? o.get_asset : o.give_asset));
  const dankPairs = new Set(dankOrders.map(o => o.give_asset === 'DANKROSECASH' ? o.get_asset : o.give_asset));
  
  console.log('FAUXCORNCASH pairs:', Array.from(fauxPairs));
  console.log('DANKROSECASH pairs:', Array.from(dankPairs));
  
  console.log('Direct DANK/FAUX orders:', fauxOrders.filter(o => 
    (o.give_asset === 'FAUXCORNCASH' && o.get_asset === 'DANKROSECASH') ||
    (o.give_asset === 'DANKROSECASH' && o.get_asset === 'FAUXCORNCASH')
  ).length);
}

main().catch(console.error);
