async function main() {
  const urls = [
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/master/directories.json',
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/master/src/assets/directories.json',
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/master/assets/directories.json',
    'https://raw.githubusercontent.com/jdogresorg/FreeWallet/main/directories.json'
  ];
  for (const u of urls) {
      try {
        const res = await fetch(u);
        console.log(u, res.status);
      } catch(e) {}
  }
}
main();
