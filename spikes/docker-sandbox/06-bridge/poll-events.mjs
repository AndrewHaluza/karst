// Single-clock round trip: host appends ping N (host monotonic start), sandbox responder echoes it
// into pong.ndjson, host polls pong every 10 ms. Only the host clock is used; one-way ~ RTT/2.
import fs from 'node:fs';
const [dir, n] = [process.argv[2], Number(process.argv[3] ?? 20)];
const ping = `${dir}/ping.ndjson`, pong = `${dir}/pong.ndjson`;
fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(ping, ''); fs.writeFileSync(pong, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rtt = [];
for (let i = 0; i < n; i++) {
  const t0 = process.hrtime.bigint();
  fs.appendFileSync(ping, `${i}\n`);
  for (;;) {
    if (fs.readFileSync(pong, 'utf8').split('\n').includes(String(i))) break;
    if (process.hrtime.bigint() - t0 > 5_000_000_000n) { console.log(JSON.stringify({ timeout: i })); process.exit(1); }
    await sleep(10);
  }
  rtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
  await sleep(200);
}
rtt.sort((a, b) => a - b);
const q = (p) => rtt[Math.min(rtt.length - 1, Math.floor(rtt.length * p))];
console.log(JSON.stringify({ n, rttMsP50: q(0.5), rttMsP95: q(0.95), rttMsMax: rtt.at(-1), oneWayApproxP50: q(0.5) / 2 }));
