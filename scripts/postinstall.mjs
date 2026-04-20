#!/usr/bin/env node
/**
 * Claudex postinstall — downloads the platform-correct ripgrep binary
 * and pre-pulls the approved Ollama cloud model aliases.
 *
 * Runs automatically after `npm install -g @abdoknbgit/claudex`.
 * Skips silently on any error so a network hiccup never breaks the install.
 * The CLI falls back to a system `rg` if the vendored binary is absent,
 * and first-launch code will retry any missed Ollama pulls.
 */

import { existsSync, mkdirSync, createWriteStream, unlinkSync, readdirSync, renameSync } from 'fs';
import { chmod } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';
import { tmpdir } from 'os';

// KEEP IN SYNC with src/utils/model/ollamaCatalog.ts (CLOUD_MODELS_LIST).
const OLLAMA_CLOUD_MODELS = [
  'glm-5.1:cloud',
  'glm-5:cloud',
  'glm-4.7:cloud',
  'glm-4.6:cloud',
  'kimi-k2.5:cloud',
  'kimi-k2-thinking:cloud',
  'qwen3.5:cloud',
  'qwen3-coder-next:cloud',
  'minimax-m2.7:cloud',
  'minimax-m2.5:cloud',
  'minimax-m2.1:cloud',
  'minimax-m2:cloud',
  'nemotron-3-super:cloud',
  'deepseek-v3.2:cloud',
  'gemini-3-flash-preview:cloud',
];

const RG_VERSION = '14.1.1';

// Map Node's (platform-arch) pair to the ripgrep release info
const PLATFORM_MAP = {
  'win32-x64':   { target: 'x86_64-pc-windows-msvc',   ext: 'zip',    binary: 'rg.exe', dir: 'x64-win32'   },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc',  ext: 'zip',    binary: 'rg.exe', dir: 'arm64-win32'  },
  'darwin-x64':  { target: 'x86_64-apple-darwin',       ext: 'tar.gz', binary: 'rg',     dir: 'x64-darwin'   },
  'darwin-arm64':{ target: 'aarch64-apple-darwin',      ext: 'tar.gz', binary: 'rg',     dir: 'arm64-darwin' },
  'linux-x64':   { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz', binary: 'rg',     dir: 'x64-linux'    },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', binary: 'rg',     dir: 'arm64-linux'  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const info = PLATFORM_MAP[key];

  if (!info) {
    console.log(`[claudex] ripgrep: unsupported platform ${key}, skipping download (system rg will be used)`);
    return;
  }

  const destDir = join(packageRoot, 'dist', 'vendor', 'ripgrep', info.dir);
  const destBinary = join(destDir, info.binary);

  if (existsSync(destBinary)) {
    // Already present (e.g. local dev build that bundled it)
    return;
  }

  const archiveName = `ripgrep-${RG_VERSION}-${info.target}.${info.ext}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}`;
  const tmpArchive = join(tmpdir(), archiveName);

  console.log(`[claudex] Downloading ripgrep ${RG_VERSION} for ${key}...`);

  try {
    await download(url, tmpArchive);
    mkdirSync(destDir, { recursive: true });
    await extract(tmpArchive, info.ext, info.binary, destDir);
    if (process.platform !== 'win32') {
      await chmod(destBinary, 0o755);
    }
    console.log(`[claudex] ripgrep installed at ${destBinary}`);
  } catch (err) {
    console.warn(`[claudex] ripgrep download failed (${err.message}). The Grep tool will fall back to system rg.`);
  } finally {
    try { if (existsSync(tmpArchive)) unlinkSync(tmpArchive); } catch { /* ignore */ }
  }
}

/** Download url → dest, following redirects. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(currentUrl, { headers: { 'User-Agent': 'claudex-postinstall' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          res.resume(); // drain so the connection is freed
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    }

    get(url);
  });
}

/** Extract the ripgrep binary from the archive into destDir. */
async function extract(archivePath, ext, binaryName, destDir) {
  if (ext === 'tar.gz') {
    // Use system tar (available on macOS, Linux, and Windows 10+)
    const result = spawnSync(
      'tar',
      ['-xzf', archivePath, '--strip-components=1', '--wildcards', `*/${binaryName}`, '-C', destDir],
      { stdio: 'pipe' }
    );
    if (result.status !== 0) {
      // Fallback: extract all and find the binary
      spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
      // Move binary from nested dir to destDir if needed
      moveNestedBinary(destDir, binaryName);
    }
  } else {
    // ZIP — use PowerShell on Windows (built-in since Windows 5.1)
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${destDir}_tmp"; ` +
        `$rg = Get-ChildItem -Recurse "${destDir}_tmp" -Filter "${binaryName}" | Select-Object -First 1; ` +
        `Move-Item -Force $rg.FullName "${destDir}\\${binaryName}"; ` +
        `Remove-Item -Recurse -Force "${destDir}_tmp"`
      ],
      { stdio: 'pipe' }
    );
    if (result.status !== 0) {
      throw new Error(`PowerShell extraction failed: ${result.stderr?.toString()}`);
    }
  }
}

/** If tar extracted into a subdirectory, move the binary up. */
function moveNestedBinary(destDir, binaryName) {
  for (const entry of readdirSync(destDir)) {
    const candidate = join(destDir, entry, binaryName);
    if (existsSync(candidate)) {
      renameSync(candidate, join(destDir, binaryName));
      return;
    }
  }
}

/**
 * Pre-pull the approved Ollama cloud aliases so the /models picker shows
 * them as ready to use. Cloud aliases resolve instantly (just register a
 * client-side reference), so the cost is a handful of fast round-trips.
 * Any failure — Ollama not installed, daemon not running, network hiccup,
 * model missing — is swallowed; first-launch code retries what's missing.
 */
function primeOllamaCloudModels() {
  // Detect ollama CLI first so we skip silently on machines without it.
  const probe = spawnSync('ollama', ['--version'], { stdio: 'ignore', timeout: 5000 });
  if (probe.status !== 0) return;

  console.log(`[claudex] Pre-pulling ${OLLAMA_CLOUD_MODELS.length} Ollama cloud aliases...`);
  let ok = 0;
  let fail = 0;
  for (const model of OLLAMA_CLOUD_MODELS) {
    const res = spawnSync('ollama', ['pull', model], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    if (res.status === 0) ok += 1; else fail += 1;
  }
  console.log(`[claudex] Ollama pre-pull: ${ok} ok, ${fail} skipped/failed (first launch will retry).`);
}

main()
  .catch(() => { /* never propagate — ripgrep is optional */ })
  .finally(() => {
    try { primeOllamaCloudModels(); } catch { /* swallow */ }
    process.exit(0);
  });
