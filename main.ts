import { serve } from "https://deno.land/std@0.180.0/http/server.ts";
import { Hono } from "https://deno.land/x/hono@v3.1.1/mod.ts";
import { OpenAI } from "https://deno.land/x/openai@1.2.1/mod.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import "https://deno.land/std@0.180.0/dotenv/load.ts";
import { nanoid } from "https://deno.land/x/nanoid@v3.0.0/mod.ts";
import { trytm } from "https://esm.sh/v112/@bdsqqq/try@2.3.1";
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

const open_ai = new OpenAI(OPENAI_API_KEY);
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

const prompt =
  `Format this credit card transaction as valid JSON like this {"date": "2021-12-31", "time": "4:35 PM ET", "amount": "$1.00", "account": "Checking", "merchant": "Sweet Green", "category": "Restaurant"}.
  "merchant" should be enriched to the common, well-known merchant name without store specific, location, or point-of-sale provider info.
  "category" should categorize the "merchant".`;

const schema = z.object({
  date: z.string(),
  time: z.string(),
  amount: z.string(),
  account: z.string(),
  merchant: z.string(),
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

  console.time("email-parsing");
  const [payload, error] = await trytm(c.req.json());
  console.timeEnd("email-parsing");

  if (error) {
    console.error(error);
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

  console.log("Got email from", FromFull.Email, " calling OpenAI");

  console.time("openai");
  const chat_completion = await open_ai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "user",
        content: prompt + "\n\n" + txnAlert,
      },
    ],
    temperature: 0,
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
  });
  console.timeEnd("openai");

  console.log("Got chat completion");

  chat_completion.choices.forEach(async (choice) => {
    console.log(choice.message?.content);

    const [json, error] = await trytm(
      JSON.parse(choice.message?.content || "{}"),
    );

    if (error) {
      console.error(error);
      return c.text("NOT OK", 500);
    }

    const result = schema.safeParse(json);

    if (!result.success) {
      console.error(result.error);
      return c.text("NOT OK", 500);
    }

    console.log({ parsed: result.data });

    await fetch(
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
              },
            },
          ],
          typecast: true,
        }),
      },
    );

    await sendNotification(
      result.data.merchant,
      result.data.category,
      result.data.amount,
    );
  });

  return c.text("OK", 200);
});

serve(app.fetch);
