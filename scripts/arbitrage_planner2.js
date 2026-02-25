const API_BASE = 'https://api.counterparty.io:4000/v2';

async function fetchOrders(asset) {
  const res = await fetch(`${API_BASE}/assets/${asset}/orders?status=all&verbose=true`);
  const data = await res.json();
  return data.result || [];
}

async function main() {
  const fauxOrders = await fetchOrders('FAUXCORNCASH');
  const dankOrders = await fetchOrders('DANKROSECASH');

  console.log(`Open/Historical orders for FAUXCORNCASH: ${fauxOrders.length}`);
  console.log(`Open/Historical orders for DANKROSECASH: ${dankOrders.length}`);
  
  const fauxStats = {};
  for (const o of fauxOrders) {
     const other = o.give_asset === 'FAUXCORNCASH' ? o.get_asset : o.give_asset;
     if (!fauxStats[other]) fauxStats[other] = {open: 0, filled: 0, all: 0};
     fauxStats[other].all++;
     if (o.status === 'open') fauxStats[other].open++;
     if (o.status === 'filled') fauxStats[other].filled++;
  }
  
  if (fauxOrders.length > 0) {
      console.log('FAUX pairs summary:', fauxStats);
      console.log('Sample FAUX order:', fauxOrders[0]);
  }
}

main().catch(console.error);
