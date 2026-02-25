async function main() {
  const routes = [
    'https://tokenscan.io/api/project/Rare Pepe',
    'https://tokenscan.io/api/projects/Rare Pepe',
    'https://tokenscan.io/api/collection/Rare Pepe',
    'https://tokenscan.io/api/projects',
    'https://tokenscan.io/api/cards/Rare Pepe'
  ];
  for (const r of routes) {
      try {
        const res = await fetch(r);
        console.log(r, res.status);
      } catch(e) {}
  }
}
main();
