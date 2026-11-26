import {readdir, readFile} from "node:fs/promises";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";

const execFile = (file,args,options={}) => promisify(execFileCallback)(file,args,{timeout:30000,...options});
const root = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../", import.meta.url));
const projectMarkers = [
  String.fromCharCode(118, 108, 105, 118, 101, 104, 111, 117, 115, 101),
  String.fromCharCode(78, 70, 80, 53, 67, 50),
  String.fromCharCode(73, 78, 86, 50, 48, 50, 54),
].map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ""));
const markers = [
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["long numeric identifier", /\b\d{8,}\b/],
  ["separated numeric identifier", /(?<!\d)(?:\d[\s._-]*){8,}(?!\d)/],
  ["UUID-like identifier", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ["local user path", /(?:[A-Z]:[\\/]{1,4}(?:Users|home)[\\/]|file:\/{2,3}[A-Z]:[\\/]{1,4}(?:Users|home)[\\/]|%USERPROFILE%[\\/]|(?:\\\\\\\\|\/\/)[^\\/\s]+[\\/](?:Users|home)[\\/])/i],
  ["credential-like assignment", /(?:client_secret|refresh_token|access_token|password)\s*[:=]\s*["'][^<][^"']{12,}["']/i],
];
const forbiddenNames = /\.(?:sqlite(?:-(?:shm|wal))?|db|jsonl|pyc)$/i;

async function walk(dir) {
  const out = [];
  for (const item of await readdir(dir, {withFileTypes: true})) {
    if (["node_modules", ".git", "__pycache__"].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

const failures = [];
let inspectedFiles=0,inspectedHistoryFiles=0;
const progress=(phase,current,total)=>{if(current===1||current===total||current%100===0)process.stderr.write(`scan ${phase}: ${current}/${total}\n`);};
function inspectText(label, text) {
  const variants = [text, text.replace(/\\u005c/gi, "\\").replace(/\\x5c/gi, "\\")];
  let decoded = text;
  for (let index = 0; index < 2; index++) {
    try { decoded = decodeURIComponent(decoded); variants.push(decoded); } catch { break; }
  }
  const normalized = variants.join("\n").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (projectMarkers.some(marker => normalized.includes(marker))) failures.push(`${label}: project-specific marker`);
  for (const [name, pattern] of markers) {
    const candidates = name === "separated numeric identifier"
      ? variants.map(value => value.replace(/\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g, " "))
      : variants;
    if (candidates.some(value => pattern.test(value))) failures.push(`${label}: ${name}`);
  }
}
const currentFiles=await walk(root);process.stderr.write(`scan current tree: ${currentFiles.length} files\n`);
for (let index=0;index<currentFiles.length;index++) { const file=currentFiles[index];
  const path = relative(root, file).replaceAll("\\", "/");
  if (forbiddenNames.test(path)) {
    failures.push(`${path}: forbidden file`);
    continue;
  }
  const text = await readFile(file, "utf8");
  inspectText(path, text);
  inspectedFiles++;progress("current",index+1,currentFiles.length);
}

// Scan every committed file version, not only the current checkout.
const {stdout: commitsText} = await execFile("git", ["rev-list", "--all"], {cwd: repo});
const commits = commitsText.trim().split(/\r?\n/).filter(Boolean);
process.stderr.write(`scan history: ${commits.length} commits\n`);
let historyTotal=0;const commitTrees=[];
for(const commit of commits){const {stdout:tree}=await execFile("git",["ls-tree","-r","--name-only",commit],{cwd:repo});const paths=tree.split(/\r?\n/).filter(Boolean);historyTotal+=paths.length;commitTrees.push({commit,paths});}
process.stderr.write(`scan history files: ${historyTotal}\n`);
for (const {commit,paths} of commitTrees) {
  for (const path of paths) {
    if (forbiddenNames.test(path)) failures.push(`${commit}:${path}: forbidden file in history`);
    const {stdout: text} = await execFile("git", ["show", `${commit}:${path}`], {cwd: repo, maxBuffer: 8 * 1024 * 1024});
    inspectText(`${commit}:${path} in history`, text);
    inspectedHistoryFiles++;progress("history",inspectedHistoryFiles,historyTotal);
  }
}

const {stdout: metadata} = await execFile("git", ["log", "--all", "--format=%an <%ae>%n%cn <%ce>"], {cwd: repo});
const metadataEmails = [...metadata.matchAll(/<([^<>]+)>/g)].map(match => match[1]);
if (metadataEmails.some(email => !email.toLowerCase().endsWith(".invalid"))) failures.push("Git commit metadata: non-placeholder email address");
const personalMarkers = [String.fromCharCode(110, 97, 111, 116, 111), String.fromCharCode(111, 115, 104, 105, 110, 111), projectMarkers[0]];
const normalizedMetadata = metadata.toLowerCase().replace(/[^a-z0-9]/g, "");
if (personalMarkers.some(marker => normalizedMetadata.includes(marker))) failures.push("Git commit metadata: personal path/identity marker");

if (failures.length) {
  process.stderr.write([...new Set(failures)].join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`candidate scan: ${inspectedFiles} current file(s), ${inspectedHistoryFiles} historical file version(s) across ${commits.length} commit(s), 0 flagged files or metadata\n`);
}
