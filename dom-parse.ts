import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.36-alpha/deno-dom-wasm.ts";

export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc || !doc.body) {
    return "";
  }

  const { body } = doc;
  // Remove all elements with display: none
  const elements = doc.querySelectorAll("[style*='display: none']");
  for (const element of elements) {
    element._remove();
  }

  return body.textContent;
}
