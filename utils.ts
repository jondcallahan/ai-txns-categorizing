export function cleanText(text: string) {
  // Strip all newlines
  return text.replace(/\n/g, " ")
    // Combine all multiple spaces into one
    .replace(/ +/g, " ")
    // Only pass the transaction alert
    .split("You are receiving this alert because")[0];
}
