#!/usr/bin/env node
/**
 * Mechanical personal-data guard for tracked and staged repository content.
 *
 * Usage:
 *   node scripts/check-personal-data.mjs
 *   node scripts/check-personal-data.mjs --staged
 *   node scripts/check-personal-data.mjs --range main..HEAD
 */

import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWLIST = [
  'docs/src/content/docs/agent-context/zz-log/2026-04-03-vision-alignment-decisions.mdx', // Historical PII-scrubbing decision intentionally lists path patterns.
  'docs/src/content/docs/agent-context/zz-research/2026-05-04-challenge-22-target-structure-expressivity.md', // Windows MAX_PATH research intentionally uses a fictional user path.
  '.claude/agents/pre-commit-reviewer.md', // Reviewer instructions intentionally document personal-data detection patterns.
  'tests/debug-diagnostics.test.ts', // Redaction test intentionally uses a fictional home path and asserts it is scrubbed.
  'Frameworks/f3-excel-v1.2.xlsx', // Published MITRE artifact redistributed as-is; docProps name is its published author. Bytes pinned in Frameworks/mitre-f3-source.json.
  'Frameworks/sp800-53r5-control-catalog.xlsx', // Published NIST artifact redistributed as-is; docProps names are its published authors.
  'Frameworks/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx', // Published NIST artifact redistributed as-is; docProps name is its published author.
  'node_modules/**', // Third-party dependencies are not repository-authored content.
  '.git/**', // Git object and index data are internal repository metadata.
  'docs/dist/**', // Built documentation output is generated from scanned sources.
  'docs/.astro/**', // Astro cache content is generated locally.
  'test-screenshots/**', // Visual test artifacts are binary and machine-generated.
  '.obsidian-cache/**', // Downloaded Obsidian test binaries and caches are external artifacts.
  'scripts/check-personal-data.mjs', // This gate necessarily contains the patterns it detects.
];

const MAX_FILE_BYTES = 512 * 1024;
const GENERATED_SEGMENTS = new Set(['dist', 'generated']);
const EMAIL_ALLOWLIST = new Set([
  'users.noreply.github.com',
  'github-actions@github.com', // GitHub's standard Actions bot identity; public, not personal
  'example.com',
  'example.org',
  'acme.example',
  'test.invalid',
]);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  bold: isTTY ? '\x1b[1m' : '',
};

const RULES = [
  {
    name: 'machine-path-wsl',
    pattern: /(?:\/mnt\/[a-z]\/Users\/|C:[\\/]Users[\\/])/gi,
  },
  {
    name: 'machine-path-home',
    pattern: /\/home\/[a-z0-9_.-]+\//gi,
  },
  {
    name: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    // Allowlist entries may be a bare domain (exempts every address at it) or a
    // full address (exempts just that one, e.g. a well-known bot identity).
    accept: (match) => {
      const addr = match.toLowerCase();
      return !EMAIL_ALLOWLIST.has(addr) && !EMAIL_ALLOWLIST.has(addr.slice(addr.lastIndexOf('@') + 1));
    },
  },
];

function git(args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err.stderr?.toString('utf8').trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function parseNulList(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'));
}

function parseArgs(args) {
  if (args.length === 0) return { mode: 'default', label: 'tracked tree' };
  if (args.length === 1 && args[0] === '--staged') return { mode: 'staged', label: 'staged files' };
  if (args.length === 2 && args[0] === '--range' && args[1] && !args[1].startsWith('-')) {
    return { mode: 'range', range: args[1], label: `range ${args[1]}` };
  }
  throw new Error('Usage: node scripts/check-personal-data.mjs [--staged | --range <gitrange>]');
}

function enumerateFiles(options) {
  if (options.mode === 'staged') {
    return parseNulList(git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z', '--']));
  }
  if (options.mode === 'range') {
    return parseNulList(
      git(['diff', '--name-only', '--diff-filter=ACMR', '-z', options.range, '--']),
    );
  }

  const files = new Set(parseNulList(git(['ls-files', '-z'])));
  for (const path of parseNulList(
    git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z', '--']),
  )) {
    files.add(path);
  }
  return [...files];
}

function matchesAllowlist(path) {
  return ALLOWLIST.some((entry) => {
    if (entry.endsWith('/**')) return path.startsWith(entry.slice(0, -2));
    return path === entry;
  });
}

function hasGeneratedSegment(path) {
  return path.split('/').some((segment) => GENERATED_SEGMENTS.has(segment));
}


// --- Office document metadata -------------------------------------------------
// Office files are ZIP containers. The personal data in them is authorship
// metadata under docProps, not text in the body, so the binary skip below would
// miss it entirely. That is how a real full name reached an already-published
// spreadsheet in this repo (found 2026-08-19). Parsed with a minimal ZIP reader
// rather than by shelling out to `unzip`, so a missing tool cannot make a
// security gate silently pass.
const OFFICE_EXTENSIONS = ['.xlsx', '.docx', '.pptx', '.xlsm'];

// Generic tool/product identities that carry no personal information.
const OFFICE_AUTHOR_ALLOWLIST = new Set([
  '', 'microsoft office user', 'apache poi', 'openpyxl', 'libreoffice',
  'unknown', 'author', 'user', 'administrator', 'excel', 'python-docx',
]);

function readZipEntry(buffer, wantedName) {
  // Locate End Of Central Directory, allowing for a trailing comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buffer.readUInt16LE(localOffset + 26);
      const lExtraLen = buffer.readUInt16LE(localOffset + 28);
      const compSize = buffer.readUInt32LE(offset + 20);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(start, start + compSize);
      try {
        return method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8');
      } catch { return null; }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function findOfficeMetadataViolations(buffer, path) {
  const core = readZipEntry(buffer, 'docProps/core.xml');
  if (!core) return [];
  const out = [];
  const fields = [
    ['dc:creator', 'creator'],
    ['cp:lastModifiedBy', 'lastModifiedBy'],
    ['cp:manager', 'manager'],
    ['Company', 'company'],
  ];
  for (const [tag, label] of fields) {
    const m = core.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    const value = (m && m[1] ? m[1] : '').trim();
    if (!value || OFFICE_AUTHOR_ALLOWLIST.has(value.toLowerCase())) continue;
    out.push({ path, line: 1, rule: 'office-metadata-author', match: `${label}=${value}` });
  }
  return out;
}

function isBinary(buffer) {
  if (buffer.includes(0)) return true;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return true;
  }

  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes++;
  }
  return controlBytes / buffer.length > 0.01;
}

async function readWorkingTreeFile(path) {
  const absolutePath = resolve(repoRoot, path);
  try {
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) return { buffer: Buffer.from(await readlink(absolutePath)) };
    if (!fileStat.isFile()) return { skip: 'missing' };
    if (fileStat.size > MAX_FILE_BYTES) return { skip: 'large' };
    return { buffer: await readFile(absolutePath) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    try {
      return { buffer: git(['show', `:${path}`]) };
    } catch {
      return { skip: 'missing' };
    }
  }
}

async function readCandidate(path, mode) {
  if (mode === 'staged') return { buffer: git(['show', `:${path}`]) };
  return readWorkingTreeFile(path);
}

async function loadDenylist() {
  try {
    const content = await readFile(resolve(repoRoot, '.personal-data-denylist'), 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function findRegexViolations(line, lineNumber, path, rule) {
  const violations = [];
  rule.pattern.lastIndex = 0;
  for (const match of line.matchAll(rule.pattern)) {
    if (rule.accept && !rule.accept(match[0])) continue;
    violations.push({ path, line: lineNumber, rule: rule.name, match: match[0] });
  }
  return violations;
}

function findDenylistViolations(line, lineNumber, path, denylist) {
  const violations = [];
  const foldedLine = line.toLowerCase();
  for (const literal of denylist) {
    const foldedLiteral = literal.toLowerCase();
    let start = 0;
    while (start <= foldedLine.length - foldedLiteral.length) {
      const index = foldedLine.indexOf(foldedLiteral, start);
      if (index === -1) break;
      violations.push({
        path,
        line: lineNumber,
        rule: 'user-denylist',
        match: line.slice(index, index + literal.length),
      });
      start = index + Math.max(literal.length, 1);
    }
  }
  return violations;
}

function truncate(text) {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = [...new Set(enumerateFiles(options))].sort();
  const denylist = await loadDenylist();

  console.log(
    `\n  ${c.bold}${c.cyan}Personal-data check${c.reset} ${c.dim}— ${options.label}, ${files.length} candidate file${files.length === 1 ? '' : 's'}${c.reset}\n`,
  );

  const skipped = { allowlisted: 0, generated: 0, large: 0, binary: 0, missing: 0 };
  const violations = [];
  let scanned = 0;
  let passed = 0;

  for (const path of files) {
    if (matchesAllowlist(path)) {
      skipped.allowlisted++;
      continue;
    }
    if (hasGeneratedSegment(path)) {
      skipped.generated++;
      continue;
    }

    const result = await readCandidate(path, options.mode);
    if (result.skip) {
      skipped[result.skip]++;
      continue;
    }
    if (result.buffer.length > MAX_FILE_BYTES) {
      skipped.large++;
      continue;
    }
    if (OFFICE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
      scanned++;
      violations.push(...findOfficeMetadataViolations(result.buffer, path));
      continue;
    }
    if (isBinary(result.buffer)) {
      skipped.binary++;
      continue;
    }

    scanned++;
    const fileViolations = [];
    const lines = result.buffer.toString('utf8').split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1;
      for (const rule of RULES) {
        fileViolations.push(...findRegexViolations(lines[index], lineNumber, path, rule));
      }
      fileViolations.push(...findDenylistViolations(lines[index], lineNumber, path, denylist));
    }

    if (fileViolations.length === 0) passed++;
    violations.push(...fileViolations);
  }

  if (violations.length > 0) {
    console.log(`  ${c.bold}${c.red}Violations:${c.reset}\n`);
    for (const violation of violations) {
      console.log(
        `  ${violation.path}:${violation.line}  [${violation.rule}]  ${truncate(violation.match)}`,
      );
    }
    console.log('');
  }

  const failLabel = violations.length > 0 ? `   ${c.red}× ${violations.length} failed${c.reset}` : '';
  console.log(`  ${c.green}✓ ${passed} passed${c.reset}${failLabel}`);
  console.log(
    `  ${c.dim}${scanned} files scanned; skipped ${skipped.allowlisted} allowlisted, ${skipped.binary} binary, ${skipped.large} over 512 KiB, ${skipped.generated} in dist/generated paths, ${skipped.missing} missing/non-file.${c.reset}\n`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
