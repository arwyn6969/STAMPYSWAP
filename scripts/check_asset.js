const API_BASE = 'https://api.counterparty.io:4000/v2';

async function main() {
  const res = await fetch(`${API_BASE}/assets/FAUXCORNCASH`);
  const data = await res.json();
  console.log('FAUXCORNCASH:', data);
  
  const res2 = await fetch(`${API_BASE}/assets/DANKROSECASH`);
  const data2 = await res2.json();
  console.log('DANKROSECASH:', data2);
}

main().catch(console.error);
