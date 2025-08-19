import { Hono } from "hono";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { nanoid } from "nanoid";
// Simple try-catch wrapper
async function tryAsync<T>(fn: Promise<T>): Promise<[T | null, Error | null]> {
  try {
    const result = await fn;
    return [result, null];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}
import { cleanText } from "./utils.ts";
import { htmlToText } from "./dom-parse.ts";
import { sendNotification } from "./ntfy.ts";

const OPENAI_API_KEY = z.string().parse(Deno.env.get("OPENAI_API_KEY"));
const AIRTABLE_API_KEY = z.string().parse(Deno.env.get("AIRTABLE_API_KEY"));
export const AIRTABLE_BASE_ID = z.string().parse(
  Deno.env.get("AIRTABLE_BASE_ID"),
);
export const AIRTABLE_TABLE_NAME = z.string().parse(
  Deno.env.get("AIRTABLE_TABLE_NAME"),
);

const model = openai.responses("gpt-5");

const app = new Hono();

type PostmarkWebhookPayload = {
  FromFull: {
    Email: string;
    Name: string;
  };
  TextBody: string;
  HtmlBody: string;
};

// const prompt =
//   'Extract and format the transaction information as valid JSON from this email using schema {"date": string, "time": string, "amount": string, "account": string, "merchant": string, "category": string}"merchant" should be transformed to the human readable merchant name stripped of store specific info in sentence case. "category" is the merchant category. Reply only with JSON. Example: {"date": "2021-01-01", "time": "12:00:00", "amount": "1.00", "account": "Checking", "merchant": "Amazon", "category": "Online Retail"}';

// const prompt =
//   `Extract and format the transaction information as valid JSON from this email using schema {"date": string, "time": string, "amount": string, "account": string, "merchant": string, "category": string} "merchant" should be transformed to the human readable merchant name stripped of store specific info in sentence case. "category" is the merchant category. Reply only with JSON. Example: {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking", "merchant": "Amazon", "category": "Online Retail"}`;

// const prompt =
//   `Extract and format the transaction information as valid JSON from this email using schema {"date": string, "time": string, "amount": string, "account": string, "merchant": string, "category": string} "merchant" should be transformed to the human readable merchant name stripped of store specific/location info. "category" is the merchant category. Reply only with JSON. Example: {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking", "merchant": "Amazon", "category": "Online Retail"}`;

// const prompt =
//   `Format this credit card transaction as valid JSON like this {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking", "merchant": "Sweet Green", "category": "Restaurant"}.
//   "merchant" should be enriched to the common, well-known merchant name without store specific, location, or point-of-sale provider info.
//   "category" should categorize the "merchant".`;

// Deprecated 2023-04-30
// const prompt =
//   `Format this credit card transaction as valid JSON like this {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking", "merchant": "Sweet Green", "category": "Restaurant"}.
//   "merchant" should be enriched to the common, well-known merchant name without store specific, location, or point-of-sale provider info, formatted for legibility.
//   "category" should categorize the "merchant" into a budget category.`;

// Deprecated 2023-11-05
// const prompt =
//   `Format this credit card transaction as valid JSON like this {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (...123)", "merchant": "Sweet Green", "category": "Restaurant"}.
//   "merchant" should be enriched to the common, well-known merchant name without store specific, location, or point-of-sale provider info, formatted for legibility. If the merchant is part of a restaurant group, extract the specific restaurant name instead of the group name.
//   "category" should categorize the "merchant" into a budget category. Reply with JSON only.`;

// const prompt = `
// Here are the details of a credit card transaction:

// <transaction>
// {TRANSACTION}
// </transaction>

// Please format this transaction as a JSON object with the following fields and formats:

// - "date" should be in the format YYYY-MM-DD
// - "time" should be in the format HH:MM AM/PM TIMEZONE
// - "amount" should be in the format $X.XX
// - "account" should be the name and last 4 digits of the account number in parentheses
// - "merchant_raw" should be the exact merchant name as it appears in the transaction details above
// - "merchant" should be the common, well-known name for this merchant, without any store numbers,
// locations, or point-of-sale provider information. Format it for maximum legibility. If the merchant
// is part of a restaurant group, extract the specific restaurant name rather than using the group
// name.
// - "category" can ONLY be one of the following values: "Auto", "Food & Dining", "Pet", "Travel",
// "Home", "Utilities", "Gifts/Donation", "Shopping", "Baby/Kid", "Taxes", or "Other". If the merchant
// does not clearly fit into any of those categories, use "Other". Note that grocery store purchases
// should be categorized as "Food & Dining".

// Output the JSON object with no other explanatory text. Here is an example of the desired output
// format:

// <example>
// {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (1234)",
// "merchant_raw": "SQ* SWEET GREEN CHICAGO", "merchant": "Sweet Green", "category": "Food & Dining"}
// </example>
// `;

const prompt = `
You are an expert in parsing credit card transactions and categorizing them.
<transaction>
{TRANSACTION}
</transaction>

<example>
{"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (1234)",
"merchant_raw": "SQ* SWEET GREEN CHICAGO", "merchant": "Sweet Green", "category": "Food & Dining"}
</example>

<example>
{"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (1234)",
"merchant_raw": "TST* LEA FRENCH STRE", "merchant": "Lea French Street Food", "category": "Food & Dining"}
</example>
`;

const schema = z.object({
  date: z.string().describe("Date of the transaction in YYYY-MM-DD format"),
  time: z.string().describe(
    "Time of the transaction in HH:MM AM/PM TIMEZONE format",
  ),
  amount: z.string().describe("Amount of the transaction in $X.XX format"),
  account: z.string().describe(
    "Name and last 4 digits of the account number in parentheses",
  ),
  merchant_raw: z.string().describe(
    "Exact merchant name as it appears in the transaction details",
  ),
  merchant: z.string().describe(
    "Common, well-known name for this merchant, without any store numbers, locations, or point-of-sale provider information. Format it for maximum legibility. If the merchant is part of a restaurant group, extract the specific restaurant name rather than using the group name. If the name is cut off, provide the full name.",
  ),
  category: z.enum([
    "Auto",
    "Food & Dining",
    "Pet",
    "Travel",
    "Home",
    "Utilities",
    "Gifts/Donation",
    "Shopping",
    "Baby/Kid",
    "Taxes",
    "Other",
  ])
    .describe(
      `Category of the transaction. If the merchant
    does not clearly fit into any of those categories, use "Other". Note that grocery store purchases
    should be categorized as "Food & Dining".`,
    ),
}).describe(
  "Credit card transaction alert extracted from an email",
);

app.get("/", () => {
  return new Response("YO Deno!", {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "text-encoding": "utf-8",
    },
  });
});
app.post("/inbound-email", async (c) => {
  console.log("Got inbound email webhook from Postmark!");

  const [payload, payload_error] = await tryAsync(c.req.json());

  if (payload_error) {
    console.error(payload_error);
    return c.text("Unable to parse email", 415, {
      "accept": "application/json",
    });
  }

  const { TextBody, FromFull, HtmlBody } = payload as PostmarkWebhookPayload;

  if (!TextBody && !HtmlBody) {
    console.error("No text or html body found");
    return c.text("No text or html body found", 400);
  }

  // TextBody might be an empty string, if so, use the HTML body
  const txnAlert = TextBody
    ? cleanText(TextBody)
    : cleanText(htmlToText(HtmlBody));

  console.log(
    "Got email from",
    FromFull.Email,
    " calling LLM with payload:",
  );
  console.log(txnAlert);
  const content = prompt.replace("{TRANSACTION}", txnAlert);
  console.log("Calling LLM with content:", content);

  console.time("llm_completion");
  const [_transaction, transactionError] = await tryAsync(
    generateObject({
      model,
      messages: [{
        role: "user",
        content,
      }],
      schema,
      maxRetries: 3,
    }),
  );
  console.timeEnd("llm_completion");

  if (transactionError) {
    console.error(transactionError);
    return c.text("Error processing email", 500);
  }
  const transaction = (_transaction as any)?.object;

  console.log("🧾 Transaction:", transaction);
  if ((_transaction as any)?.reasoning) {
    console.log("🧠 Reasoning:", (_transaction as any).reasoning);
  }

  // const airtable_res = await fetch(
  //   `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`,
  //   {
  //     method: "POST",
  //     headers: {
  //       "Content-Type": "application/json",
  //       Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  //     },
  //     body: JSON.stringify({
  //       records: [
  //         {
  //           fields: {
  //             ID: nanoid(),
  //             Date: transaction.date,
  //             Time: transaction.time,
  //             Amount: transaction.amount,
  //             Account: transaction.account,
  //             Merchant: transaction.merchant,
  //             Category: transaction.category,
  //             "Merchant raw": transaction.merchant_raw,
  //           },
  //         },
  //       ],
  //       typecast: true,
  //     }),
  //   },
  // );

  // if (!airtable_res.ok) {
  //   console.error("Error calling Airtable: " + await airtable_res.text());
  //   return c.text("NOT OK", 500);
  // } else {
  //   console.log("Saved to Airtable");
  // }

  if (Deno.env.get("ENV_NAME") !== "dev") {
    await sendNotification(
      transaction.merchant,
      transaction.category,
      transaction.amount,
    );
  }

  return c.text("OK", 200);
  // return c.json(transaction);
});

Deno.serve(app.fetch);
