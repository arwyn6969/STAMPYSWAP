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
