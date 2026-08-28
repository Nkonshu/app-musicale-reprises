const fs = require('fs');
const path = require('path');

const FAL_STORAGE_INITIATE = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

function authHeaders() {
  return { Authorization: `Key ${process.env.FAL_KEY}` };
}

async function uploadFile(filePath, contentType) {
  const initRes = await fetch(FAL_STORAGE_INITIATE, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: path.basename(filePath), content_type: contentType }),
  });
  if (!initRes.ok) {
    throw new Error(`Fal upload initiate failed: ${initRes.status} ${await initRes.text()}`);
  }
  const { file_url, upload_url } = await initRes.json();

  const buf = fs.readFileSync(filePath);
  const putRes = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buf,
  });
  if (!putRes.ok) {
    throw new Error(`Fal upload PUT failed: ${putRes.status} ${await putRes.text()}`);
  }
  return file_url;
}

async function runModel(modelPath, input) {
  const res = await fetch(`https://fal.run/${modelPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Fal model ${modelPath} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = { uploadFile, runModel, downloadToFile };
