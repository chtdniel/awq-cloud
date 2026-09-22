import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const documents = [
  { id: 2, file: 'Operations Manual Part A.pdf' },
  { id: 3, file: 'Flight Dispatch Manual.pdf' },
  { id: 4, file: 'CASR Part 121 Amdt. 12.pdf' }
];
const downloads = process.env.AWQ_REFERENCE_SOURCE_DIR || path.join(process.env.USERPROFILE || '', 'Downloads');
const pdftotext = process.env.PDFTOTEXT_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe' : 'pdftotext');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awq-reference-index-'));

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function chunks(text) {
  const normalized = text.replaceAll('\r', '').replace(/\f+/g, '\n\n');
  const paragraphs = normalized.split(/\n\s*\n/).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const result = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > 1800) {
      if (current) result.push(current);
      current = '';
      for (let index = 0; index < paragraph.length; index += 1700) result.push(paragraph.slice(index, index + 1700));
      continue;
    }
    if ((current + ' ' + paragraph).trim().length > 1800) {
      if (current) result.push(current);
      current = paragraph;
    } else current = `${current} ${paragraph}`.trim();
  }
  if (current) result.push(current);
  return result;
}

const statements = [];
for (const document of documents) {
  const filePath = path.join(downloads, document.file);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    console.warn(`Skipping missing PDF: ${filePath}`);
    continue;
  }
  const text = execFileSync(pdftotext, ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
  const parts = chunks(text);
  statements.push(`DELETE FROM reference_document_chunks WHERE reference_document_id = ${document.id};`);
  parts.forEach((content, index) => statements.push(
    `INSERT INTO reference_document_chunks (reference_document_id, chunk_index, content) VALUES (${document.id}, ${index}, ${sql(content)});`
  ));
  console.log(`${document.file}: ${parts.length} chunks`);
}

const sqlPath = path.join(tempDir, 'reference-index.sql');
fs.writeFileSync(sqlPath, statements.join('\n'), 'utf8');
if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', `npx wrangler d1 execute awq-db --remote --file="${sqlPath}"`], { stdio: 'inherit' });
} else {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'awq-db', '--remote', `--file=${sqlPath}`], { stdio: 'inherit' });
}
fs.rmSync(tempDir, { recursive: true, force: true });
