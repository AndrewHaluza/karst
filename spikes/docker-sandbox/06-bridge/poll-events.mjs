// Host side of candidate C: poll append-only NDJSON in the mounted worktree, report latency.
import fs from 'node:fs';
const [file, n, outMs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4] ?? 15000)];
const lat = []; let off = 0; const t0 = Date.now();
const iv = setInterval(() => {
  if (!fs.existsSync(file)) return;
  const buf = fs.readFileSync(file, 'utf8'); const chunk = buf.slice(off); off = buf.length;
  for (const l of chunk.split('\n').filter(Boolean)) lat.push(Date.now() - JSON.parse(l).ts);
  if (lat.length >= n || Date.now() - t0 > outMs) {
    clearInterval(iv); lat.sort((a, b) => a - b);
    console.log(JSON.stringify({ got: lat.length, p50: lat[Math.floor(lat.length/2)], p95: lat[Math.floor(lat.length*0.95)], max: lat.at(-1) }));
  }
}, 50);
