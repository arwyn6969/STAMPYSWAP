document.addEventListener("DOMContentLoaded", function() {
  const submitButton = document.getElementById("submit-button");
  const tokenNameInput = document.getElementById("token-name");
  const availablePairsSection = document.getElementById("available-pairs-section");

  submitButton.addEventListener("click", function() {
    const tokenName = tokenNameInput.value;
    // Fetch available pairs based on tokenName
    // Populate availablePairsSection with the fetched data
  });
});
