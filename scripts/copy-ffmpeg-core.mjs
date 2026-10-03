import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = resolve(root, "node_modules/@ffmpeg/core/dist/esm");
const ffmpegSource = resolve(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const target = resolve(root, "public/vendor/ffmpeg");

await mkdir(target, { recursive: true });

// Copy ffmpeg-core files
await copyFile(resolve(coreSource, "ffmpeg-core.js"), resolve(target, "ffmpeg-core.js"));
await copyFile(resolve(coreSource, "ffmpeg-core.wasm"), resolve(target, "ffmpeg-core.wasm"));

// Also keep chunked parts if needed
const wasm = await readFile(resolve(coreSource, "ffmpeg-core.wasm"));
const chunkSize = 16 * 1024 * 1024;
const parts = Math.ceil(wasm.length / chunkSize);
await Promise.all(Array.from({ length: parts }, (_, index) => {
  const start = index * chunkSize;
  return writeFile(resolve(target, `ffmpeg-core.wasm.part${index + 1}`), wasm.subarray(start, start + chunkSize));
}));

// Also copy ffmpeg worker files so they can be loaded statically if necessary
await copyFile(resolve(ffmpegSource, "worker.js"), resolve(target, "worker.js")).catch(() => {});
await copyFile(resolve(ffmpegSource, "const.js"), resolve(target, "const.js")).catch(() => {});
await copyFile(resolve(ffmpegSource, "errors.js"), resolve(target, "errors.js")).catch(() => {});

console.log(`FFmpeg core & wasm copied into public/vendor/ffmpeg (direct wasm + ${parts} parts)`);
