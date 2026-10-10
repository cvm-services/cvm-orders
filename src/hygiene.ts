/**
 * ADR-0013 — card custody. Card material never enters this service.
 *
 * The console refuses card data on the device and hands the customer off to the
 * venue/PSP payment page. This module is the server-side half of that rule: an
 * order field that looks like a PAN / CVV / card number is refused at the
 * boundary, before any state change, and nothing here is ever logged.
 */

export class CardMaterialRefused extends Error {
  constructor(where: string) {
    super(`card material refused at ${where} (ADR-0013)`);
    this.name = "CardMaterialRefused";
  }
}

/** Field names that mean "card data" whoever sends them. */
const CARD_KEYS =
  /^(pan|card[_ -]?(number|no|num)|cvv|cvc|cvn|csc|security[_ -]?code|expir(y|es|ation)|exp[_ -]?date|cardholder|card[_ -]?holder|ccnum|credit[_ -]?card|track2)$/i;

/**
 * Luhn-valid 13..19 digit strings are treated as a PAN.
 *
 * A leading "+" marks a phone number (the order payload carries
 * `customer.phone`) and is never a PAN, so it is exempt.
 */
export function looksLikePan(value: string): boolean {
  if (value.trimStart().startsWith("+")) return false;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * An ISO-8601 timestamp is never card material, but stripping its separators
 * leaves a 17-digit run that passes the Luhn check for ~1 in 10 timestamps
 * (measured: 60 of 600 consecutive seconds). The receipt the console posts on
 * `placed` carries `captured_at` = `new Date().toISOString()`, so without this
 * exemption the guard refused a legitimate receipt at random — the same defect
 * the console fixed in its own copy of this guard (cvm-registry t_4726349b).
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function walk(value: unknown, where: string, path: string, seen: Set<unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ISO_TIMESTAMP.test(value)) return; // a time, not a card number
    if (looksLikePan(value)) throw new CardMaterialRefused(`${where}:${path} (PAN-shaped value)`);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, where, `${path}[${i}]`, seen));
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (CARD_KEYS.test(key)) throw new CardMaterialRefused(`${where}:${path}.${key} (card field)`);
    walk(inner, where, `${path}.${key}`, seen);
  }
}

/**
 * Fail closed: throws `CardMaterialRefused` (never returns a verdict) so a
 * caller cannot forget to check the result.
 */
export function assertNoCardMaterial(value: unknown, where = "order"): void {
  walk(value, where, where, new Set());
}
