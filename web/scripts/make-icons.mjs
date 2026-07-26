// Renders the app icon SVG to the PNG sizes a PWA needs.
// Run with: node scripts/make-icons.mjs   (requires playwright + chromium)
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "icons",
);

/** Original chat-bubble mark — deliberately not Apple's Messages icon. */
const svg = (size, maskable) => {
  const pad = maskable ? size * 0.18 : size * 0.08;
  const inner = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4fa3ff"/>
      <stop offset="100%" stop-color="#0a7cff"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${maskable ? 0 : size * 0.22}" fill="url(#g)"/>
  <g transform="translate(${pad} ${pad})">
    <path d="M ${inner * 0.5} ${inner * 0.16}
             C ${inner * 0.79} ${inner * 0.16} ${inner * 0.9} ${inner * 0.34} ${inner * 0.9} ${inner * 0.5}
             C ${inner * 0.9} ${inner * 0.66} ${inner * 0.79} ${inner * 0.82} ${inner * 0.5} ${inner * 0.82}
             C ${inner * 0.43} ${inner * 0.82} ${inner * 0.37} ${inner * 0.81} ${inner * 0.32} ${inner * 0.8}
             L ${inner * 0.16} ${inner * 0.88}
             L ${inner * 0.21} ${inner * 0.72}
             C ${inner * 0.14} ${inner * 0.66} ${inner * 0.1} ${inner * 0.59} ${inner * 0.1} ${inner * 0.5}
             C ${inner * 0.1} ${inner * 0.34} ${inner * 0.21} ${inner * 0.16} ${inner * 0.5} ${inner * 0.16} Z"
          fill="#ffffff"/>
  </g>
</svg>`;
};

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: false },
  { file: "favicon-64.png", size: 64, maskable: false },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
for (const { file, size, maskable } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}</style>${svg(size, maskable)}`,
  );
  const buf = await page.screenshot({ omitBackground: true });
  await writeFile(path.join(outDir, file), buf);
  await page.close();
  console.log(`wrote ${file} (${size}px)`);
}
await browser.close();
