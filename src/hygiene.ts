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

/** Luhn check over a pure digit string. */
function passesLuhn(digits: string): boolean {
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

/** The PAN window. Not a knob: 13..19 + Luhn is what makes this check mean anything. */
function inPanWindow(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19;
}

/**
 * Luhn-valid 13..19 digit strings are treated as a PAN, both as a whole value
 * and as a run inside one.
 *
 * Two shapes have to be refused, and neither check alone covers both:
 *
 * * the value *is* a PAN, however it is grouped — a 4-4-4-4 spaced or dashed
 *   card number. Caught by stripping the value and testing it once.
 * * the value *contains* one — `"pi_3Qk9Zx2eZvKYlo2C 4242424242424242"`, the
 *   plausible paste of a card number after a PSP reference. Caught by scanning
 *   the contiguous digit runs, which the whole-value form misses: stripping
 *   concatenates the reference's own digits with the card number and lands
 *   outside the window (the console's copy of this guard has exactly that gap;
 *   `cvm-registry` t_d38f4d20 holds the decision for the client half).
 *
 * A leading "+" marks a phone number (the order payload carries
 * `customer.phone`) and is never a PAN, so it is exempt.
 *
 * Residual, stated rather than hidden: a *space-grouped* PAN that follows
 * another digit run in the same value (`"ref 1234 " + a 4-4-4-4 grouped PAN`)
 * is stripped to more than 19 digits and has no 13..19 run, so it is not
 * caught. Closing it needs sliding windows inside the stripped value, which
 * would refuse the service's own epoch-millisecond-shaped data at random — the
 * bug class the ISO exemption below exists to fix. See `tests/hygiene_test.ts`.
 */
export function looksLikePan(value: string): boolean {
  if (value.trimStart().startsWith("+")) return false;
  const stripped = value.replace(/[^0-9]/g, "");
  if (inPanWindow(stripped) && passesLuhn(stripped)) return true;
  for (const run of value.match(/[0-9]+/g) ?? []) {
    if (inPanWindow(run) && passesLuhn(run)) return true;
  }
  return false;
}

/**
 * An ISO-8601 timestamp is never card material. Belt and braces: scanning digit
 * runs no longer sees a timestamp as PAN-shaped at all, but the exemption is
 * kept because the whole-value form did — stripping the separators from
 * `new Date().toISOString()` leaves a 17-digit run, and ~1 in 10 of those pass
 * the Luhn check (measured: 60 of 600 consecutive seconds). The receipt the
 * console posts on `placed` carries `captured_at` = `new Date().toISOString()`,
 * so that form refused a legitimate receipt at random — the same defect the
 * console fixed in its own copy of this guard (committed as `1d53cac` on
 * `pr/console-happy-path-video`, found by `cvm-registry` t_4726349b).
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
