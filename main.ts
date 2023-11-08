import { Hono } from "hono";
import { OpenAI } from "openai";
import { z } from "zod";
import "https://deno.land/std@0.180.0/dotenv/load.ts";
import { nanoid } from "nanoid";
import { trytm } from "trytm";
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

const open_ai = new OpenAI({
  apiKey: OPENAI_API_KEY,
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
Please format this credit card transaction as JSON.
  "date" should be in the format YYYY-MM-DD.
  "merchant_raw" should be the exact merchant name as it appears on the credit card statement.
  "merchant" should be enriched to the common, well-known merchant name without store-specific, location, or point-of-sale provider info, formatted for legibility. If the merchant is part of a restaurant group, extract the specific restaurant name instead of the group name.
  "category" can only be: "Auto", "Food & Dining", "Pet", "Travel", "Home", "Utilities", "Gifts/Donation", "Shopping", "Baby/Kid", "Taxes", or "Other" ONLY. If the category does not match any of these, please specify it as "Other".

Reply with JSON only.
Example:

{"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking (...123)", "merchant_raw": "SQ* SWEET GREEN CHICAGO", "merchant": "Sweet Green", "category": "Food & Dining"}
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
    " calling OpenAI with payload:",
  );
  console.log(txnAlert);

  console.time("openai");
  const chat_completion = await open_ai.chat.completions.create({
    model: "gpt-3.5-turbo-1106",
    messages: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: txnAlert,
      },
    ],
    temperature: 0.1,
    response_format: {
      type: "json_object",
    },
  }, {
    timeout: 20_000,
  });
  console.timeEnd("openai");

  console.log("Got chat completion");

  const completion = JSON.parse(
    chat_completion.choices[0].message.content || "{}",
  );

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
