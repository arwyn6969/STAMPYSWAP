async function main() {
  const urls = [
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/master/src/config.js',
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/master/src/directories.json'
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u);
      console.log(u, res.status);
    } catch(e) {}
  }
}
main();
