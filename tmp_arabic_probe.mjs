import { readFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const fontBytes = readFileSync('./public/fonts/Amiri-Regular.ttf');
const base64Font = Buffer.from(fontBytes).toString('base64');

const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
pdf.addFileToVFS('Amiri-Regular.ttf', base64Font);
pdf.addFont('Amiri-Regular.ttf', 'Amiri', 'normal');
pdf.setFont('Amiri', 'normal');
pdf.setFontSize(32);

const samples = [
  'مرحبا بالعالم هذا نص عربي صحيح ومثبت داخل ملف PDF',
  'هذا مثال عربي بدون أي تحويلات إضافية',
  'ملاحظات: أرقام 1، 2، 3 في النص العربي',
];

samples.forEach((sample, idx) => {
  pdf.text(sample, 195, 30 + idx * 20, { align: 'right' });
});

pdf.save('./tmp_probe.pdf');

const pdfData = new Uint8Array(readFileSync('./tmp_probe.pdf'));
const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
let extracted = '';
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i);
  const textContent = await page.getTextContent();
  extracted += textContent.items.map((item) => item.str).join(' ');
}

console.log('EXTRACTED:', extracted);
console.log('HAS_ARABIC:', /[\u0600-\u06FF\u0750-\u077F]/.test(extracted));
