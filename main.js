document.addEventListener("DOMContentLoaded", function() {
  const submitButton = document.getElementById("submit-button");
  const tokenNameInput = document.getElementById("token-name");
  const availablePairsSection = document.getElementById("available-pairs-section");

  submitButton.addEventListener("click", function() {
    const tokenName = tokenNameInput.value;
    fetchAvailablePairs(tokenName);
  });
});

// Function to fetch available pairs from the XCP API
function fetchAvailablePairs(tokenName) {
  // Replace with the actual API endpoint
  const apiEndpoint = `https://xchain.io/api/market/${tokenName}`;

  fetch(apiEndpoint)
    .then(response => response.json())
    .then(data => {
      displayAvailablePairs(data);
    })
    .catch(error => {
      console.error("Error fetching data:", error);
    });
}

// Function to display available pairs
function displayAvailablePairs(data) {
  const availablePairsSection = document.getElementById("available-pairs-section");
  availablePairsSection.innerHTML = ""; // Clear previous data

  // Loop through the data to create HTML elements for each available pair
  // For demonstration, assuming data is an array of pair names
  data.forEach(pair => {
    const pairElement = document.createElement("div");
    pairElement.textContent = pair.name;
    
    const quoteButton = document.createElement("button");
    quoteButton.textContent = "Quote";
    quoteButton.addEventListener("click", function() {
      generateQuote(pair);
    });

    pairElement.appendChild(quoteButton);
    availablePairsSection.appendChild(pairElement);
  });
}

// Function to generate a quote for the selected pair
function generateQuote(pair) {
  // Logic to generate a quote based on the selected pair
  // This will involve another API call to get pricing information
}



// Function to generate a quote for the selected pair
function generateQuote(pair) {
  // Logic to generate a quote based on the selected pair
  // This will involve another API call to get pricing information
  // For demonstration, let's assume the quote is generated successfully
  displayQuote(100); // Replace 100 with the actual quote
}

// Function to display the quote
function displayQuote(quote) {
  const quoteSection = document.getElementById("quote-section");
  quoteSection.innerHTML = `Quote: ${quote} XCP`;

  const orderButton = document.createElement("button");
  orderButton.textContent = "Order";
  orderButton.addEventListener("click", function() {
    displayOrderPopup(quote);
  });

  quoteSection.appendChild(orderButton);
}

// Function to display the order popup with QR code and transaction data
function displayOrderPopup(quote) {
  // Logic to generate QR code and transaction data
  // For demonstration, let's assume we have a QR code URL and transaction data
  const qrCodeUrl = "https://example.com/qr-code.png";
  const transactionData = "Sample Transaction Data";

  const popup = window.open("", "Order Popup", "width=400,height=400");
  popup.document.write(`<h1>Order Details</h1>`);
  popup.document.write(`<img src="${qrCodeUrl}" alt="QR Code">`);
  popup.document.write(`<p>${transactionData}</p>`);

  // Close the popup after 1 minute
  setTimeout(() => {
    popup.close();
  }, 60000);
}



// Function to fetch unconfirmed transactions for a specific asset
async function fetchUnconfirmedTransactions(asset) {
  const url = `https://xchain.io/api/mempool/${asset}`;
  const response = await fetch(url);
  const data = await response.json();
  
  return data;
}

// Function to check if there are unconfirmed transactions that might affect the market
async function checkForUnconfirmedTransactions(asset) {
  const unconfirmedTransactions = await fetchUnconfirmedTransactions(asset);
  
  // Logic to check if any of the unconfirmed transactions might affect the market order
  // This will depend on the specifics of how the XChain market works
  // For now, let's assume we simply check if there are any unconfirmed transactions
  
  if (unconfirmedTransactions.total > 0) {
    return true;
  } else {
    return false;
  }
}



