const fs = require('fs');

const REPLICATE_API = 'https://api.replicate.com/v1';

function authHeaders() {
  return { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` };
}

async function uploadFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('content', new Blob([buf]), filePath.split(/[\\/]/).pop());

  const res = await fetch(`${REPLICATE_API}/files`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Replicate upload failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.urls.get;
}

async function runPrediction(version, input, { pollIntervalMs = 3000, timeoutMs = 120000 } = {}) {
  const createRes = await fetch(`${REPLICATE_API}/predictions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, input }),
  });
  if (!createRes.ok) {
    throw new Error(`Replicate prediction failed: ${createRes.status} ${await createRes.text()}`);
  }
  let prediction = await createRes.json();

  const deadline = Date.now() + timeoutMs;
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
    if (Date.now() > deadline) {
      throw new Error(`Replicate prediction timed out after ${timeoutMs}ms (id=${prediction.id})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollRes = await fetch(prediction.urls.get, { headers: authHeaders() });
    prediction = await pollRes.json();
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error || 'no error message'}`);
  }
  return prediction.output;
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, url.startsWith(REPLICATE_API) ? { headers: authHeaders() } : undefined);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = { uploadFile, runPrediction, downloadToFile };
