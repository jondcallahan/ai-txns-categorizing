import { Hono } from "hono";
import { z } from "zod";
import "https://deno.land/std@0.180.0/dotenv/load.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.19.0";
import { nanoid } from "nanoid";
import { trytm } from "trytm";
import { cleanText } from "./utils.ts";
import { htmlToText } from "./dom-parse.ts";
import { sendNotification } from "./ntfy.ts";

const ANTHROPIC_API_KEY = z.string().parse(Deno.env.get("ANTHROPIC_API_KEY"));
const AIRTABLE_API_KEY = z.string().parse(Deno.env.get("AIRTABLE_API_KEY"));
export const AIRTABLE_BASE_ID = z.string().parse(
  Deno.env.get("AIRTABLE_BASE_ID"),
);
export const AIRTABLE_TABLE_NAME = z.string().parse(
  Deno.env.get("AIRTABLE_TABLE_NAME"),
);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

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

const prompt = `
Here are the details of a credit card transaction:

<transaction>
{TRANSACTION}
</transaction>

Please format this transaction as a JSON object with the following fields and formats:

- "date" should be in the format YYYY-MM-DD
- "time" should be in the format HH:MM AM/PM TIMEZONE
- "amount" should be in the format $X.XX
- "account" should be the name and last 4 digits of the account number in parentheses
- "merchant_raw" should be the exact merchant name as it appears in the transaction details above
- "merchant" should be the common, well-known name for this merchant, without any store numbers,
locations, or point-of-sale provider information. Format it for maximum legibility. If the merchant
is part of a restaurant group, extract the specific restaurant name rather than using the group
name.
- "category" can ONLY be one of the following values: "Auto", "Food & Dining", "Pet", "Travel",
"Home", "Utilities", "Gifts/Donation", "Shopping", "Baby/Kid", "Taxes", or "Other". If the merchant
does not clearly fit into any of those categories, use "Other". Note that grocery store purchases
should be categorized as "Food & Dining".

Output the JSON object with no other explanatory text. Here is an example of the desired output
format:

<example>
{"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (1234)",
"merchant_raw": "SQ* SWEET GREEN CHICAGO", "merchant": "Sweet Green", "category": "Food & Dining"}
</example>
`;

const schema = z.object({
  date: z.string(),
  time: z.string(),
  amount: z.string(),
  account: z.string(),
  merchant: z.string(),
  merchant_raw: z.string(),
  category: z.string(),
});

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

  const [payload, payload_error] = await trytm(c.req.json());

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

  console.time("llm_completion");
  const chat_completion = await anthropic.messages.create({
    model: "claude-3-sonnet-20240229",
    messages: [
      {
        role: "user",
        content: prompt.replace("{TRANSACTION}", txnAlert),
      },
    ],
    temperature: 0.1,
    max_tokens: 256,
  });
  console.timeEnd("llm_completion");

  console.log(
    "Got chat completion",
    chat_completion.content.at(-1)?.text,
  );

  const completion = JSON.parse(chat_completion.content.at(-1)?.text || "{}");
  const result = schema.safeParse(completion);

  if (!result.success) {
    console.log("Completion does not match schema");
    console.log(completion);
    console.error(result.error);
    return c.text("NOT OK", 500);
  }

  console.log(result.data);

  const airtable_res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              ID: nanoid(),
              Date: result.data.date,
              Time: result.data.time,
              Amount: result.data.amount,
              Account: result.data.account,
              Merchant: result.data.merchant,
              Category: result.data.category,
              "Merchant raw": result.data.merchant_raw,
            },
          },
        ],
        typecast: true,
      }),
    },
  );

  if (!airtable_res.ok) {
    console.error("Error calling Airtable: " + await airtable_res.text());
    return c.text("NOT OK", 500);
  } else {
    console.log("Saved to Airtable");
  }

  await sendNotification(
    result.data.merchant,
    result.data.category,
    result.data.amount,
  );

  return c.text("OK", 200);
});

Deno.serve(app.fetch);
