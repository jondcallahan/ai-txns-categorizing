import { AIRTABLE_TABLE_NAME } from "./main.ts";
import { AIRTABLE_BASE_ID } from "./main.ts";


export function sendNotification(merchant_name: string, category: string, amount: string) {
  return fetch(`https://ntfy.sh/ai-txns-${AIRTABLE_BASE_ID}`, {
    method: "POST",
    headers: {
      "Click": `https://airtable.com/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`,
    },
    body: `Saved txn at ${merchant_name} (${category}) for ${amount}`
  })
}
