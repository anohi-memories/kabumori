// The asset-summary card's decorative background and the trend-aware sparkline. The RN components are read as
// text (like the rest of this suite); the trend rule is pure and tested behaviourally.
import assert from "node:assert/strict";
import test from "node:test";

import { sparklineTrend, sparklineValues } from "../../src/lib/portfolio-view.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const ASSET = "assets/images/portfolio/portfolio_asset_card_growth_background.webp";

async function* sourceFiles(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* sourceFiles(child);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield child;
  }
}

test("the approved background asset is the transparent 1600x700 WebP at its stable path", async () => {
  const bytes = await Deno.readFile(new URL(ASSET, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8X", "an extended WebP (carries alpha)");
  assert.ok((bytes[20] & 0x10) !== 0, "the alpha flag is set");
  const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
  const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
  assert.deepEqual([width, height], [1600, 700]);
  // No unrelated portfolio asset was added next to it.
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/portfolio/", repoRoot))) names.push(entry.name);
  assert.deepEqual(names, ["portfolio_asset_card_growth_background.webp"]);
});

test("the artwork is referenced only by the asset-summary card", async () => {
  const users: string[] = [];
  for await (const file of sourceFiles(new URL("src/", repoRoot))) {
    if ((await Deno.readTextFile(file)).includes("portfolio_asset_card_growth_background")) users.push(file.pathname.replace(repoRoot.pathname, ""));
  }
  assert.deepEqual(users, ["src/components/portfolio/portfolio-sections.tsx"]);
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  const usage = sections.slice(sections.indexOf("export function AssetSummaryCard"), sections.indexOf("// ---- AI summary"));
  assert.ok(usage.includes("source={ASSET_CARD_BACKGROUND}"), "only inside the AssetSummaryCard");
  assert.equal((sections.match(/ASSET_CARD_BACKGROUND/g) ?? []).length, 2, "declared once, used once");
});

test("the decoration sits behind the content, is clipped to the card, takes no touches and is hidden from accessibility", async () => {
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  const card = sections.slice(sections.indexOf("export function AssetSummaryCard"), sections.indexOf("// ---- AI summary"));
  const image = card.indexOf("<Image");
  assert.ok(image > 0 && image < card.indexOf("styles.assetTop") && image < card.indexOf("<Sparkline") && image < card.indexOf("资产") + 1e9, "the image is the first child");
  assert.ok(image < card.indexOf("<Metric"), "behind the metrics too");
  assert.ok(card.includes("pointerEvents=\"none\"") && card.includes("accessible={false}"));
  assert.ok(card.includes("style={[styles.card, styles.assetCard]}"));
  assert.ok(/assetCard: \{ overflow: 'hidden' \}/.test(sections), "clipped to the rounded card");
  const style = sections.match(/assetBackground: \{[^}]*\}/)?.[0] ?? "";
  assert.ok(style.includes("position: 'absolute'") && style.includes("top: 0") && style.includes("aspectRatio: 1600 / 700"), style);
  const opacity = Number(/opacity: ([0-9.]+)/.exec(style)?.[1]);
  assert.ok(opacity >= 0.3 && opacity <= 0.5, `translucent (${opacity}), neither strong nor invisible`);
  assert.ok(card.includes('contentFit="cover"') && !/contentFit="fill"/.test(card), "never stretched");
});

test("the sparkline colour follows the REAL first-vs-last trend: up green, down muted red, flat neutral", async () => {
  assert.equal(sparklineTrend([100, 90, 120, 130]), "up");
  assert.equal(sparklineTrend([100, 130, 80, 90]), "down", "a falling history is never 'up'");
  assert.equal(sparklineTrend([3000000, 3100000, 2900000, 3000000]), "flat");
  assert.equal(sparklineTrend([3000000, 3001000]), "flat", "a ¥1,000 move on ¥3M is within the 0.05% band");
  assert.equal(sparklineTrend([3000000, 3003000]), "up");
  assert.equal(sparklineTrend([5, 5, 5]), "flat");
  assert.equal(sparklineTrend([1000, 1500]), "up");
  assert.equal(sparklineTrend([1, 1.5]), "flat", "within the ¥1 floor");
  assert.equal(sparklineTrend([]), "none");
  assert.equal(sparklineTrend([42]), "none");
  assert.equal(sparklineTrend([100, Number.NaN]), "none");
  const theme = await code("src/components/portfolio/portfolio-theme.ts");
  assert.ok(theme.includes("trend === 'up' ? PF.up : trend === 'down' ? PF.down : PF.flat"), "green / red / neutral");
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("color={sparkColor(sparklineTrend(spark))}"));
  assert.ok(!/color=\{PF\.up\}/.test(sections), "no hard-coded green sparkline any more");
  const view = await code("src/lib/portfolio-view.ts");
  assert.ok(!/color|#[0-9a-f]{6}/i.test(view.slice(view.indexOf("export function sparklineTrend"), view.indexOf("// ---- impact top 3"))), "the rule itself is colour-free");
});

test("no fixed decorative chart, no invented or smoothed points; 0-1 usable points still draw no sparkline", async () => {
  const spark = await code("src/components/portfolio/sparkline.tsx");
  assert.ok(!/\[\s*-?\d+(\.\d+)?\s*(,\s*-?\d+(\.\d+)?\s*){2,}\]/.test(spark), "no literal number series");
  assert.ok(!/Math\.random|bezier|spline|interpolat|smooth/i.test(spark), "no generated or smoothed values");
  assert.ok(spark.includes("values.map((value, index)") && spark.includes("points.slice(1).map("), "one point per real value, one bar per gap");
  assert.ok(spark.includes("if (values.length < 2 || width <= 0 || height <= 0) return null;"));
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("{spark.length >= 2 ? ("), "the card renders no sparkline slot for 0-1 points");
  // The data side is unchanged: only real saved close totals, a single point is returned as-is.
  const report = (date: string, value: number) => ({
    id: date, report_type: "close", trading_date: date, title_ja: null, summary_ja: null, body: null, generated_at: `${date}T07:00:00Z`,
    portfolio_snapshot: { totals: { market_value: value } },
  }) as unknown as Parameters<typeof sparklineValues>[0][number];
  assert.deepEqual(sparklineValues([report("2026-10-06", 300)]), [300]);
  assert.deepEqual(sparklineValues([]), []);
  assert.deepEqual(sparklineValues([report("2026-10-05", 200), report("2026-10-06", 300)]), [200, 300]);
});

test("the sparkline is a thin line with smooth joins and one restrained end dot (no per-vertex joint dots)", async () => {
  const spark = await code("src/components/portfolio/sparkline.tsx");
  assert.ok(/const thickness = 2;/.test(spark), "thin");
  assert.ok(!/joint/i.test(spark), "the busy joint dots are gone");
  assert.ok(spark.includes("Math.hypot(dx, dy) + thickness"), "round caps overlap neighbouring bars, hiding the seams");
  assert.ok(spark.includes("borderRadius: thickness / 2"));
  assert.equal((spark.match(/styles\.dot/g) ?? []).length, 1, "one end dot");
  assert.ok(/dot: \{[^}]*width: 7, height: 7/.test(spark), "small");
  // The fade under the line was intentionally omitted: no area/gradient element is drawn.
  assert.ok(!/gradient|area|fade/i.test(spark));
});

test("no dependency was added and the neighbouring contracts are untouched", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(!deps.some((name) => /chart|svg|gradient|skia|reanimated-.*chart/i.test(name)));
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("<Metric label=\"評価損益\"") && sections.includes("<Metric label={labels.dayChange}"), "lower metrics unchanged");
  assert.ok(sections.includes("router.push({ pathname: '/report-detail', params: { id: reportId } })"), "report navigation unchanged");
});
