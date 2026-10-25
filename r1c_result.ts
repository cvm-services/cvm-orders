import { CashuRail } from "./src/rail.ts";

const quote = Deno.args[0];
if (!quote) {
  console.error("usage: r1c_result.ts <melt-quote-id>");
  Deno.exit(2);
}
const rail = new CashuRail({
  baseUrl: Deno.env.get("R1C_MINT") ?? "https://mint.minibits.cash/Bitcoin",
});
console.log("MINT VERDICT:", (await rail.checkMelt(quote)).toUpperCase());
