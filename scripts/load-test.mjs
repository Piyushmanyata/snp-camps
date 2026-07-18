import { performance } from "node:perf_hooks";

const baseUrl = process.env.LOAD_BASE_URL?.replace(/\/$/, "");
const virtualUsers = Number(process.env.LOAD_VUS || 25);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS || 30);
const paths = (process.env.LOAD_PATHS || "/,/register,/patient/login")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.startsWith("/"));

if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  throw new Error("Set LOAD_BASE_URL to an http(s) staging URL.");
}
if (
  !Number.isInteger(virtualUsers) ||
  virtualUsers < 1 ||
  virtualUsers > 5_000
) {
  throw new Error("LOAD_VUS must be an integer from 1 to 5000.");
}
if (virtualUsers > 100 && process.env.ALLOW_HIGH_LOAD !== "true") {
  throw new Error("Set ALLOW_HIGH_LOAD=true for more than 100 VUs.");
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 900) {
  throw new Error("LOAD_DURATION_SECONDS must be between 5 and 900.");
}
if (!paths.length) throw new Error("LOAD_PATHS must contain at least one safe GET path.");

const deadline = performance.now() + durationSeconds * 1_000;
const latencies = [];
let requests = 0;
let failures = 0;
const statusCounts = {};

async function virtualUser(id) {
  let index = id % paths.length;
  while (performance.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const started = performance.now();
    try {
      const response = await fetch(baseUrl + paths[index], {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "snp-staging-load-harness/1.0" },
      });
      statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
      if (response.status < 200 || response.status >= 400) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      clearTimeout(timeout);
      latencies.push(performance.now() - started);
      requests += 1;
    }

    index = (index + 1) % paths.length;
    await new Promise((resolve) =>
      setTimeout(resolve, 250 + Math.floor(Math.random() * 750)),
    );
  }
}

await Promise.all(
  Array.from({ length: virtualUsers }, (_, index) => virtualUser(index)),
);

latencies.sort((a, b) => a - b);
const percentile = (value) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] || 0;
const errorRate = requests ? failures / requests : 1;
const result = {
  baseUrl,
  virtualUsers,
  durationSeconds,
  requests,
  requestsPerSecond: Number((requests / durationSeconds).toFixed(2)),
  failures,
  errorRate: Number((errorRate * 100).toFixed(2)),
  statusCounts,
  latencyMs: {
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    p99: Math.round(percentile(0.99)),
  },
};

console.log(JSON.stringify(result, null, 2));
if (errorRate >= 0.01 || result.latencyMs.p95 >= 1_500) process.exitCode = 1;
