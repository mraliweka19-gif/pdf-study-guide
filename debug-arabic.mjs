import arabicReshaper from './node_modules/arabic-reshaper/index.js';
import bidiFactory from './node_modules/bidi-js/index.js';

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

const sample = 'مرحبا بالعالم هذا نص عربي صحيح ومثبت داخل ملف PDF';
console.log('sample:', sample);
console.log('normalized:', normalizeArabicForPdf(sample));

const mixed = 'الملف: exam-1، الفصل الأول';
console.log('mixed:', normalizeArabicForPdf(mixed));
