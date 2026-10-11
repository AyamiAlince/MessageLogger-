// Пересчитывает hash в manifest.json — Kettu перекачивает index.js только когда hash меняется.
// Запуск: node update-hash.mjs
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.hash = createHash("sha256").update(readFileSync(join(dir, manifest.main))).digest("hex").slice(0, 16);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
console.log("hash =", manifest.hash);
