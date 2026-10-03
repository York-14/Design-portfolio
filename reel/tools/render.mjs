// Offline exporter: renders every frame of reel/index.html in headless Chromium and pipes it to ffmpeg.
// usage: node reel/tools/render.mjs [--stills 0.8,3.0,...] [--out dir]
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = "file://" + path.resolve(here, "../index.html") + "#render";
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const outDir = opt("--out") || path.resolve(here, "../out"); mkdirSync(outDir, { recursive: true });
const stills = opt("--stills");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, userAgent: UA });
page.on("console", m => { if (m.type() === "error") console.error("[page]", m.text()); });
page.on("pageerror", e => console.error("[pageerror]", e.message));
// fonts come through curl so the sandbox proxy/CA is respected
await page.route(/fonts\.(googleapis|gstatic)\.com/, async route => {
  const url = route.request().url();
  const body = execFileSync("curl", ["-sS", "-A", UA, url], { maxBuffer: 64 << 20 });
  const ct = url.includes("googleapis") ? "text/css" : "font/woff2";
  await route.fulfill({ status: 200, body, headers: { "content-type": ct, "access-control-allow-origin": "*" } });
});
await page.goto(page_url);
await page.waitForFunction(() => window.REEL && window.REEL.ready, null, { timeout: 120000 });
console.log("fonts:", await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => f.family).filter((v, i, a) => a.indexOf(v) === i).join(", ")));

const grab = t => page.evaluate(t => { window.REEL.render(t); return document.getElementById("out").toDataURL("image/png"); }, t);

if (stills) {
  for (const s of stills.split(",").map(Number)) {
    const d = await grab(s); writeFileSync(path.join(outDir, `still_${s.toFixed(2)}.png`), Buffer.from(d.split(",")[1], "base64"));
  }
  console.log("stills written to", outDir);
} else {
  const fps = await page.evaluate(() => window.REEL.FPS), dur = await page.evaluate(() => window.REEL.DUR);
  const wav = await page.evaluate(async () => window.REEL.wavBase64(await window.REEL.buildAudio(48000)));
  const wavPath = path.join(outDir, "reel_audio.wav"); writeFileSync(wavPath, Buffer.from(wav, "base64"));
  const mp4 = path.join(outDir, "order-x-chaos-reel.mp4");
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-i", wavPath,
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-tune", "film", "-movflags", "+faststart",
    "-af", "alimiter=limit=0.89:level=false,loudnorm=I=-14:TP=-1.0:LRA=7", "-ar", "48000", "-c:a", "aac", "-b:a", "256k", "-shortest", mp4], { stdio: ["pipe", "inherit", "inherit"] });
  const N = Math.round(fps * dur), t0 = Date.now();
  for (let f = 0; f < N; f++) {
    const d = await grab(f / fps);
    if (!ff.stdin.write(Buffer.from(d.split(",")[1], "base64"))) await new Promise(r => ff.stdin.once("drain", r));
    if (f % 60 === 0) console.log(`frame ${f}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise(r => ff.on("close", r));
  console.log("wrote", mp4);
}
await browser.close();
