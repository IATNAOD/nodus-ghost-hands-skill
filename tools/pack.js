// pack.js - ZIP скилла для панели и портала (Node 22; npm i adm-zip)
//   node pack.js <папка скилла> [каталог для архива, по умолчанию dist]
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const root = path.resolve(process.argv[2] || ".");
const outDir = path.resolve(process.argv[3] || "dist");
// служебное - на любой глубине; test и dist - только в корне
const SKIP = new Set(["node_modules", "package.json", "package-lock.json", "yarn.lock", "Thumbs.db"]);
const skip = (name, rel) =>
  SKIP.has(name) || name.startsWith(".") || name.endsWith(".zip") || (!rel && ["test", "dist"].includes(name));
const walk = (abs, rel = "") =>
  fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => !skip(entry.name, rel))
    .flatMap((entry) => {
      const name = rel ? `${rel}/${entry.name}` : entry.name; // в ZIP разделитель только "/"
      return entry.isDirectory() ? walk(path.join(abs, entry.name), name) : [name];
    });

// BOM или ошибка JSON падают здесь, а не "skill.json is not valid JSON" на устройстве
const { id, version } = JSON.parse(fs.readFileSync(path.join(root, "skill.json"), "utf8"));
const files = walk(root);
const zip = new AdmZip();

for (const name of files) zip.addFile(name, fs.readFileSync(path.join(root, name)));
fs.mkdirSync(outDir, { recursive: true });

const zipPath = path.join(outDir, `${id}-${version}.zip`);

zip.writeZip(zipPath);

const mb = (bytes) => bytes / 1048576;
const size = mb(fs.statSync(zipPath).size);
const unpacked = mb(files.reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0));
const problems = [
  !files.includes("index.js") && "нет index.js в корне: портал не примет",
  (size > 30 || files.length > 2000 || unpacked > 50) && "больше лимитов портала: 30 МБ, 2000 файлов, 50 МБ распакованным",
  size > 50 && "больше 50 МБ: панель устройства обрежет файл",
].filter(Boolean);

console.log(`${zipPath}: ${files.length} файлов, ${size.toFixed(2)} МБ`);
problems.forEach((problem) => console.log(`! ${problem}`));
process.exitCode = problems.length ? 1 : 0;
