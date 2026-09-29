import { readFileSync, writeFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import arabicReshaper from 'arabic-reshaper';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

const normalizeArabicForPdf = (value) => {
  if (value == null) return '';

  const raw = String(value).replace(/\s+/g, ' ').trim();
  if (!raw || !/[\u0600-\u06FF\u0750-\u077F]/.test(raw)) {
    return raw;
  }

  const parts = raw.split(/(\s+|[A-Za-z0-9.,!?;:()\[\]{}%&*+=<>#_@/\\-]+)/g).filter(Boolean);
  const text = parts.map((part) => {
    if (!/[\u0600-\u06FF\u0750-\u077F]/.test(part)) {
      return part;
    }

    const reshaped = arabicReshaper.convertArabic(part);
    const embeddingLevels = bidi.getEmbeddingLevels(reshaped, 'rtl');
    const flips = bidi.getReorderSegments(reshaped, embeddingLevels);
    const chars = reshaped.split('');

    for (const [start, end] of flips) {
      const segment = chars.slice(start, end + 1).reverse();
      chars.splice(start, end - start + 1, ...segment);
    }

    return `\u202B${chars.join('')}\u202C`;
  }).join('');

  return `\u200F${text}\u200F`;
};

const fontBytes = readFileSync('./public/fonts/Amiri-Regular.ttf');
const base64Font = Buffer.from(fontBytes).toString('base64');

const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
pdf.addFileToVFS('Amiri-Regular.ttf', base64Font);
pdf.addFont('Amiri-Regular.ttf', 'Amiri', 'normal');
pdf.setFont('Amiri', 'normal');
pdf.setFontSize(32);

const sample = 'مرحبا بالعالم هذا نص عربي صحيح ومثبت داخل ملف PDF';
pdf.text(normalizeArabicForPdf(sample), 195, 40, { align: 'right' });
pdf.save('./arabic-pdf-verification.pdf');

const pdfData = new Uint8Array(readFileSync('./arabic-pdf-verification.pdf'));
const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
let extracted = '';
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i);
  const textContent = await page.getTextContent();
  extracted += textContent.items.map((item) => item.str).join(' ');
}

console.log('EXTRACTED_ARABIC:', extracted);
if (!/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(extracted)) {
  throw new Error('The generated PDF did not contain Arabic text after extraction.');
}

writeFileSync('./arabic-pdf-verification.txt', extracted, 'utf8');
console.log('Verification succeeded. Arabic text was found inside the generated PDF.');
