import React, { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  FileText,
  HelpCircle,
  Mic,
  Download,
  RefreshCw,
  Play,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Sparkles,
  Layers,
  Settings2,
  ChevronRight,
  ChevronLeft,
  FileCheck,
  UploadCloud,
  GraduationCap,
  Flame,
  Eye,
  EyeOff,
  Share2,
  FileDown,
  RotateCcw,
  Volume2,
  Smartphone,
  Monitor,
  ExternalLink,
  ListOrdered,
  Lightbulb,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import arabicReshaper from 'arabic-reshaper';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

const normalizeArabicForPdf = (value: string): string => {
  if (value == null) return '';

  const raw = String(value).replace(/\s+/g, ' ').trim();
  if (!raw) return raw;

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

const PREVIEW_DOC_TITLE = 'Study Guide';

const rtlArabicTextStyle: React.CSSProperties = {
  direction: 'rtl',
  textAlign: 'right',
  unicodeBidi: 'plaintext',
  fontFamily: 'Amiri, Tahoma, "Segoe UI", sans-serif',
};

const arabicTitleStyle: React.CSSProperties = {
  ...rtlArabicTextStyle,
  fontFamily: '"Cairo", "Amiri", Tahoma, "Segoe UI", sans-serif',
  letterSpacing: '0.01em',
};

const ensureArabicPdfFont = async (pdf: jsPDF) => {
  const fontToken = (pdf as any).__arabicFontLoaded as boolean | undefined;
  if (fontToken) return;

  try {
    const candidates = ['/fonts/Amiri-Regular.ttf', 'https://cdn.jsdelivr.net/gh/google/fonts/main/ofl/amiri/Amiri-Regular.ttf'];
    let response: Response | null = null;

    for (const url of candidates) {
      try {
        response = await fetch(url, { cache: 'force-cache' });
        if (response.ok) break;
      } catch {
        response = null;
      }
    }

    if (!response || !response.ok) {
      throw new Error('Arabic font could not be fetched from the local or remote sources.');
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    const base64 = btoa(binary);
    pdf.addFileToVFS('Amiri-Regular.ttf', base64);
    pdf.addFont('Amiri-Regular.ttf', 'Amiri', 'normal');
    (pdf as any).__arabicFontLoaded = true;
  } catch (error) {
    console.warn('Could not preload Arabic TTF font for PDF export:', error);
    (pdf as any).__arabicFontLoaded = true;
  }
};

// Declare pdfjsLib global from CDN
declare const pdfjsLib: any;

interface SlidePage {
  index: number;
  img: string;
  text: string;
}

interface SlideGroup {
  id: string;
  startSlide: number;
  endSlide: number;
  pages: SlidePage[];
  explanation: {
    topic: string;
    conceptSummary: string;
    paragraphs: string[];
    doctorTips?: string[];
    keyTerms?: Array<{ term: string; meaningAr: string }>;
    isLocalFallback?: boolean;
    isRecovered?: boolean;
  } | null;
}

interface MCQQuestion {
  question: string;
  options: string[];
  answer: string;
  difficulty?: string;
  explanation?: string;
  doctorNoteAr?: string;
}

interface EssayQuestion {
  question: string;
  difficulty?: string;
  answer: string;
  rubricPoints?: string[];
  doctorNoteAr?: string;
}

interface AudioSection {
  heading: string;
  body: string;
  points?: string[];
  doctorTipAr?: string;
}

interface AudioResult {
  fileName: string;
  title: string;
  transcript: string;
  sections: AudioSection[];
  keyTakeaways?: string[];
}

export default function App() {
  // App Mode: 'full' (Mode 1), 'questions' (Mode 2), 'audio' (Mode 3)
  const [mode, setMode] = useState<'full' | 'questions' | 'audio'>('full');
  const [deviceView, setDeviceView] = useState<'desktop' | 'mobile'>('desktop');

  // File state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePageCount, setFilePageCount] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Generation configurations
  const [slidesPerPage, setSlidesPerPage] = useState<number>(1);
  const [maxSlidesToExplain, setMaxSlidesToExplain] = useState<number>(100);
  const [mcqCount, setMcqCount] = useState<number>(5);
  const [essayCount, setEssayCount] = useState<number>(2);
  const [difficulty, setDifficulty] = useState<'mixed' | 'easy' | 'medium' | 'hard'>('mixed');
  const [showAnswers, setShowAnswers] = useState<boolean>(true);

  // Results state
  const [slideGroups, setSlideGroups] = useState<SlideGroup[]>([]);
  const [mcqs, setMcqs] = useState<MCQQuestion[]>([]);
  const [essays, setEssays] = useState<EssayQuestion[]>([]);
  const [audioResult, setAudioResult] = useState<AudioResult | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'slides' | 'questions'>('all');
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});

  // Timer & Limits (8 mins limit for generation, 2 mins recovery limit)
  const GENERATION_LIMIT_SECONDS = 480; // 8 minutes
  const RECOVERY_LIMIT_SECONDS = 120; // 2 minutes
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(GENERATION_LIMIT_SECONDS);
  const [isRecovering, setIsRecovering] = useState<boolean>(false);
  const [recoveryRemainingSeconds, setRecoveryRemainingSeconds] = useState<number>(RECOVERY_LIMIT_SECONDS);
  const [currentProgressPhase, setCurrentProgressPhase] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [isExportingPdf, setIsExportingPdf] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Cleanup timers on unmount
  useEffect(() => {
    document.title = PREVIEW_DOC_TITLE;
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(Math.max(0, secs) / 60);
    const s = Math.floor(Math.max(0, secs) % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const startGenerationTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setElapsedSeconds(0);
    setRemainingSeconds(GENERATION_LIMIT_SECONDS);
    setIsRecovering(false);
    setRecoveryRemainingSeconds(RECOVERY_LIMIT_SECONDS);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedSeconds(elapsed);
      setRemainingSeconds(Math.max(0, GENERATION_LIMIT_SECONDS - elapsed));

      if (elapsed >= GENERATION_LIMIT_SECONDS) {
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }, 1000);
  };

  const stopGenerationTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Handle File Selection
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (mode === 'audio') {
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|mp4|webm|mpeg)$/i.test(file.name);
      if (!isAudio) {
        setStatusMessage('⚠️ يرجى اختيار ملف صوتي صالح (MP3, WAV, M4A, WebM)');
        return;
      }
      setSelectedFile(file);
      setStatusMessage(`🎙️ تم تحميل التسجيل: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
      return;
    }

    if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
      setStatusMessage('⚠️ يرجى اختيار ملف PDF صالح');
      return;
    }

    setSelectedFile(file);
    setStatusMessage(`📄 جاري فحص ملف الـ PDF: ${file.name}...`);
    setUploadProgress(20);

    try {
      if (typeof pdfjsLib === 'undefined') {
        throw new Error('مكتبة PDF.js غير متوفرة حالياً');
      }
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      setFilePageCount(pdf.numPages);
      setUploadProgress(100);
      setStatusMessage(`✅ تم الفحص: ${file.name} يحتوي على ${pdf.numPages} صفحة/شريحة.`);
    } catch (err: any) {
      console.error(err);
      setStatusMessage('❌ تعذر قراءة صفحات الـ PDF، يرجى التأكد من الملف.');
    }
  };

  // Extract all PDF pages as High-Res images and text
  const extractPdfAllPages = async (file: File): Promise<SlidePage[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    const pages: SlidePage[] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      setCurrentProgressPhase(`جاري استخراج الشريحة ${pageNum} من إجمالي ${totalPages}...`);
      setProgressPercent(Math.round((pageNum / totalPages) * 35));

      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Render high resolution canvas for preview and PDF export
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imgUrl = canvas.toDataURL('image/jpeg', 0.85);
        pages.push({ index: pageNum, img: imgUrl, text: pageText });
      } else {
        pages.push({ index: pageNum, img: '', text: pageText });
      }
    }

    return pages;
  };

  // 10-minute budget per API request so slow Gemini responses aren't aborted early.
  const API_TIMEOUT_MS = 10 * 60 * 1000;

  const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = API_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  // Mode 1: Explain a slide group using Gemini with retries and recovery
  const explainSlideWithGemini = async (
    slideNumber: number,
    totalSlides: number,
    extractedText: string,
    slideImageBase64?: string,
    previousTopics: string[] = []
  ) => {
    const res = await fetchWithTimeout('/api/explain-slide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slideNumber,
        totalSlides,
        extractedText,
        slideImageBase64,
        previousTopics,
      }),
    }, API_TIMEOUT_MS);

    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }

    return await res.json();
  };

  // Local fallback if AI fails after all recovery attempts
  const normalizeExplanation = (exp: any) => {
    const topic = String(exp?.topic || 'شرح السلايد').replace(/\s+/g, ' ').trim();
    const conceptSummary = String(exp?.conceptSummary || '').replace(/\s+/g, ' ').trim();
    const rawParagraphs = Array.isArray(exp?.paragraphs) ? exp.paragraphs : [];

    const paragraphs = rawParagraphs
      .map((p: string) => String(p || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((p: string) => {
        const parts = p.split(/(?<=[.!?؟])\s+/).filter(Boolean);
        if (parts.length <= 8) return p;
        return parts.slice(0, 8).join(' ');
      })
      .slice(0, 3);

    const doctorTips = Array.isArray(exp?.doctorTips)
      ? exp.doctorTips.map((tip: string) => String(tip || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2)
      : [];

    const keyTerms = Array.isArray(exp?.keyTerms)
      ? exp.keyTerms.map((item: any) => ({
          term: String(item?.term || '').replace(/\s+/g, ' ').trim(),
          meaningAr: String(item?.meaningAr || '').replace(/\s+/g, ' ').trim(),
        })).filter((item: any) => item.term || item.meaningAr).slice(0, 3)
      : [];

    return {
      topic: topic.length > 70 ? `${topic.slice(0, 67)}...` : topic,
      conceptSummary: conceptSummary || 'الفكرة الأساسية في هذه الشريحة هي الربط بين العناصر الرئيسية في المحتوى وشرح أهميتها في المذاكرة.',
      paragraphs: paragraphs.length > 0 ? paragraphs : [
        'الموضوع الأساسي في هذه الشريحة يعتمد على الفكرة المركزية في المحتوى، ويفهم بشكل أفضل عندما نربط بين العناصر الأساسية والنقاط المتكررة في المادة.',
        'طريقة العمل هنا تتطلب متابعة التسلسل الصحيح للخطوات أو العلاقات بين المفاهيم، لأن الفهم الجيد يعتمد على ترتيب المعلومات ووضوح الروابط بينها.',
      ],
      doctorTips,
      keyTerms,
      isLocalFallback: Boolean(exp?.isLocalFallback),
      isRecovered: Boolean(exp?.isRecovered),
    };
  };

  const generateLocalEgyptianFallback = (pages: SlidePage[], startIdx: number, endIdx: number) => {
    const combined = pages.map((p) => p.text).join(' ');
    const sentences = combined.split(/[.!?؟]\s+/).filter((s) => s.length > 20);

    return normalizeExplanation({
      topic: `محتوى السلايد ${startIdx} إلى ${endIdx}`,
      conceptSummary: `الشريحة دي بتناقش المفاهيم والبيانات الرئيسية المعروضة بالصفحات ${startIdx} إلى ${endIdx}.`,
      paragraphs: [
        `المحتوى الأساسي هنا بيعتمد على النقاط الموجودة في الشريحة: ${sentences.slice(0, 2).join('. ') || 'مفاهيم ومصطلحات المادة الأكاديمية.'}`,
        `التفاصيل وطريقة العمل: ${sentences.slice(2, 4).join('. ') || 'يتم تطبيق المفاهيم بناءً على الخطوات والمعادلات الموضحة بالشرائح المرفقة.'}`,
      ],
      doctorTips: ['ركز على العناوين والمصطلحات الإنجليزية الموجودة في السلايد.'],
      keyTerms: [{ term: 'Key Concept', meaningAr: 'المفهوم الأساسي في السلايد' }],
      isLocalFallback: true,
    });
  };

  // Main Generation Handler
  const buildAudioFallbackResult = (fileName: string): AudioResult => ({
    fileName,
    title: fileName.replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
    transcript: 'تم استقبال الملف الصوتي، لكن خدمة الصوت غير متاحة في الوقت الحالي. تم تجهيز نسخة منظمة احتياطية من ملاحظات المحاضرة.',
    sections: [
      {
        heading: 'ملخص المحاضرة والمحتوى الصوتي',
        body: 'تم استلام التسجيل وحفظ بياناته. عند توفر خدمة الصوت، سيتم استبدال هذا الملخص بالتفريغ الكامل من النص الصوتي.',
        points: ['تسجيل المحاضرة كامل', 'تجهيز نقاط المراجعة الأكاديمية', 'تنظيم المحتوى في أقسام واضحة'],
        doctorTipAr: 'راجع الأفكار الرئيسية في التسجيل مع الشرائح المرفقة لتحقيق أقصى استفادة.'
      }
    ],
    keyTakeaways: ['المراجعة المنتظمة للمحاضرة', 'التركيز على تنبيهات الدكتور', 'تجهيز ملخصات للامتحان النهائي'],
  });

  const audioBufferToWav = (buffer: AudioBuffer): ArrayBuffer => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const wavBuffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(wavBuffer);

    const writeString = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    const channelData = Array.from({ length: numChannels }, (_, ch) => buffer.getChannelData(ch));

    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return wavBuffer;
  };

  const createAudioChunks = async (file: File, maxChunkSeconds = 180): Promise<string[]> => {
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|mp4|webm|mpeg)$/i.test(file.name)) {
      return [await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })];
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        return [await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        })];
      }

      const audioContext = new AudioContextClass();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const duration = audioBuffer.duration;
      const chunkCount = Math.ceil(duration / maxChunkSeconds);

      if (chunkCount <= 1) {
        await audioContext.close();
        return [await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        })];
      }

      const chunks: string[] = [];
      const chunkLength = Math.max(1, Math.floor(audioBuffer.length / chunkCount));

      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkLength;
        const end = Math.min(start + chunkLength, audioBuffer.length);

        const chunkBuffer = new AudioBuffer({
          length: end - start,
          numberOfChannels: audioBuffer.numberOfChannels,
          sampleRate: audioBuffer.sampleRate,
        });

        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          const source = audioBuffer.getChannelData(channel).slice(start, end);
          chunkBuffer.copyToChannel(source, channel, 0);
        }

        const wavBuffer = audioBufferToWav(chunkBuffer);
        const bytes = new Uint8Array(wavBuffer);
        let binary = '';
        for (let j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j]);
        }
        chunks.push(`data:audio/wav;base64,${btoa(binary)}`);
      }

      await audioContext.close();
      return chunks;
    } catch (error) {
      console.warn('Audio chunking failed, using single-file upload fallback:', error);
      return [await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })];
    }
  };

  const transcribeAudioChunk = async (audioBase64: string, fileName: string, mimeType: string) => {
    const controller = new AbortController();
    const audioTimeoutMs = API_TIMEOUT_MS;
    const timeoutId = window.setTimeout(() => controller.abort(), audioTimeoutMs);

    try {
      const res = await fetch('/api/transcribe-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType,
          fileName,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json() as Partial<AudioResult>;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleGenerate = async () => {
    if (!selectedFile) {
      setStatusMessage('⚠️ يرجى تحميل ملف أولاً');
      return;
    }

    setIsProcessing(true);
    startGenerationTimer();
    setSlideGroups([]);
    setMcqs([]);
    setEssays([]);
    setAudioResult(null);

    try {
      // ----------------------------------------------------
      // MODE 3: Audio to Organized Notes
      // ----------------------------------------------------
      if (mode === 'audio') {
        setCurrentProgressPhase('جاري معالجة وتفريغ التسجيل الصوتي بالذكاء الاصطناعي...');
        setProgressPercent(20);

        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(selectedFile);
        });

        const audioBase64 = await base64Promise;
        setProgressPercent(35);

        try {
          const largeAudioChunks = await createAudioChunks(selectedFile, 180);

          if (largeAudioChunks.length > 1) {
            setCurrentProgressPhase('تجهيز التسجيل إلى أجزاء قصيرة وتحليل كل جزء ثم دمجه في ملخص واحد...');
            setProgressPercent(45);

            const chunkResults: Partial<AudioResult>[] = [];
            const totalChunks = largeAudioChunks.length;

            for (let i = 0; i < largeAudioChunks.length; i++) {
              const chunkBase64 = largeAudioChunks[i];
              const chunkResult = await transcribeAudioChunk(chunkBase64, `${selectedFile.name} - جزء ${i + 1}`, selectedFile.type || 'audio/mpeg');
              if (chunkResult && (chunkResult.transcript || chunkResult.sections || chunkResult.keyTakeaways)) {
                chunkResults.push(chunkResult);
              }
              setProgressPercent(Math.min(90, 45 + Math.round(((i + 1) / totalChunks) * 45)));
            }

            const combinedTranscript = chunkResults
              .map((result) => result.transcript || '')
              .filter(Boolean)
              .join('\n\n---\n\n');

            const combinedSections = chunkResults.flatMap((result) => Array.isArray(result.sections) ? result.sections : []);
            const combinedKeyTakeaways = chunkResults.flatMap((result) => Array.isArray(result.keyTakeaways) ? result.keyTakeaways : []);

            const result = {
              fileName: selectedFile.name,
              title: chunkResults[0]?.title || selectedFile.name.replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
              transcript: combinedTranscript || 'تم تجزئة المحاضرة وتحليل كل جزء بنجاح.',
              sections: combinedSections.length > 0 ? combinedSections : [
                {
                  heading: 'ملخص المحاضرة',
                  body: 'تم تقسيم المحاضرة إلى أجزاء وتحليلها بشكل متسلسل ثم تجميعها في ملخص واحد.',
                  points: ['مراجعة كل جزء على حدة', 'تجميع النقاط الرئيسية', 'تنظيم النتائج في مذكرات دراسية'],
                  doctorTipAr: 'راجع كل جزء قبل تجميع الملخص النهائي.'
                }
              ],
              keyTakeaways: combinedKeyTakeaways.length > 0 ? combinedKeyTakeaways : ['تمت مراجعة المحاضرة كأجزاء متسلسلة', 'تم تجميع أهم النقاط في ملخص واحد', 'التطبيق على أسئلة المراجعة'],
            };

            setAudioResult(result);
            setProgressPercent(100);
            setStatusMessage('✅ تم تفريغ المحاضرة في أجزاء ثم دمجها بنجاح!');
            stopGenerationTimer();
            setIsProcessing(false);
            return;
          }

          setCurrentProgressPhase('الذكاء الاصطناعي يستمع ويكتب المحاضرة وينظمها في مذكرات دراسية...');
          setProgressPercent(50);

          const controller = new AbortController();
          const audioTimeoutMs = API_TIMEOUT_MS;
          const timeoutId = window.setTimeout(() => controller.abort(), audioTimeoutMs);

          const res = await fetchWithTimeout('/api/transcribe-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64,
              mimeType: selectedFile.type,
              fileName: selectedFile.name,
            }),
          }, 480000);

          clearTimeout(timeoutId);

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }

          const audioData: Partial<AudioResult> = await res.json();
          const result = {
            fileName: selectedFile.name,
            title: audioData.title || selectedFile.name.replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
            transcript: audioData.transcript || '',
            sections: Array.isArray(audioData.sections) ? audioData.sections : [],
            keyTakeaways: Array.isArray(audioData.keyTakeaways) ? audioData.keyTakeaways : [],
          };

          setAudioResult(result);
          setProgressPercent(100);
          setStatusMessage('✅ تم تفريغ وتنظيم المحاضرة بنجاح!');
          stopGenerationTimer();
          setIsProcessing(false);
          return;
        } catch (audioError) {
          console.error('Audio transcription fetch failed:', audioError);
          const fallbackResult = buildAudioFallbackResult(selectedFile.name);
          setAudioResult(fallbackResult);
          setProgressPercent(100);
          setStatusMessage('⚠️ لا يوجد اتصال بالخادم في الوقت الحالي، تم تجهيز ملخص احتياطي للمحاضرة بنجاح.');
          stopGenerationTimer();
          setIsProcessing(false);
          return;
        }
      }

      // ----------------------------------------------------
      // MODE 1 & MODE 2: PDF Processing
      // ----------------------------------------------------
      setCurrentProgressPhase('جاري استخراج وقراءة جميع صفحات الـ PDF بدقة عالية...');
      const allPages = await extractPdfAllPages(selectedFile);

      if (allPages.length === 0) {
        throw new Error('لم يتم العثور على أي محتوى داخل الملف');
      }

      // Group pages according to user choice.
      // In full mode, user can cap the number of explained slides to keep processing faster.
      const pagesToProcess = mode === 'full'
        ? allPages.slice(0, Math.min(maxSlidesToExplain, allPages.length))
        : allPages;

      const groups: SlideGroup[] = [];
      const dynamicGroupSize = mode === 'questions'
        ? 1
        : Math.max(1, Math.min(slidesPerPage, pagesToProcess.length > 120 ? 2 : pagesToProcess.length > 50 ? 3 : slidesPerPage));

      for (let i = 0; i < pagesToProcess.length; i += dynamicGroupSize) {
        const slice = pagesToProcess.slice(i, i + dynamicGroupSize);
        const start = i + 1;
        const end = Math.min(i + dynamicGroupSize, pagesToProcess.length);
        groups.push({
          id: `group-${start}-${end}`,
          startSlide: start,
          endSlide: end,
          pages: slice,
          explanation: null,
        });
      }

      // ----------------------------------------------------
      // MODE 1: Explain Each Slide in Egyptian Arabic
      // ----------------------------------------------------
      if (mode === 'full') {
        const previousTopics: string[] = [];
        const failedGroupIndices: number[] = [];

        // Primary Pass
        for (let g = 0; g < groups.length; g++) {
          const group = groups[g];
          const progressVal = 35 + Math.round(((g + 1) / groups.length) * 40);
          setProgressPercent(progressVal);
          setCurrentProgressPhase(
            `الذكاء الاصطناعي يشرح السلايد ${group.startSlide} إلى ${group.endSlide} بالعامية المصرية...`
          );

          const combinedText = group.pages.map((p) => p.text).join('\n\n');
          const primaryImage = group.pages[0]?.img || undefined;

          try {
            const exp = await explainSlideWithGemini(
              group.startSlide,
              allPages.length,
              combinedText,
              primaryImage,
              previousTopics
            );

            group.explanation = normalizeExplanation({
              ...exp,
              isLocalFallback: false,
            });

            if (exp?.topic) previousTopics.push(exp.topic);
          } catch (err) {
            console.warn(`Primary explanation failed for group ${g + 1}:`, err);
            failedGroupIndices.push(g);
          }
        }

        // Recovery Pass (with dedicated 2-minute time window as requested)
        if (failedGroupIndices.length > 0) {
          setIsRecovering(true);
          setCurrentProgressPhase(
            `⚠️ جاري تشغيل محرك الاسترداد الذكي (Recovery Engine) لإعادة معالجة ${failedGroupIndices.length} مجموعة...`
          );

          const recoveryStart = Date.now();
          const recoveryTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recoveryStart) / 1000);
            setRecoveryRemainingSeconds(Math.max(0, RECOVERY_LIMIT_SECONDS - elapsed));
          }, 1000);

          for (const idx of failedGroupIndices) {
            if (Date.now() - recoveryStart > RECOVERY_LIMIT_SECONDS * 1000) {
              break;
            }

            const group = groups[idx];
            try {
              const combinedText = group.pages.map((p) => p.text).join('\n\n');
              const exp = await explainSlideWithGemini(
                group.startSlide,
                allPages.length,
                combinedText,
                group.pages[0]?.img,
                previousTopics
              );

              group.explanation = normalizeExplanation({
                ...exp,
                isLocalFallback: false,
                isRecovered: true,
              });
            } catch (recoveryErr) {
              console.error(`Recovery also failed for group ${idx + 1}, using safe local fallback:`, recoveryErr);
              group.explanation = generateLocalEgyptianFallback(group.pages, group.startSlide, group.endSlide);
            }
          }

          clearInterval(recoveryTimer);
          setIsRecovering(false);
        }

        setSlideGroups([...groups]);
      }

      // ----------------------------------------------------
      // Generate Doctor-Level University Questions
      // ----------------------------------------------------
      if (mcqCount > 0 || essayCount > 0) {
        setProgressPercent(80);
        setCurrentProgressPhase(
          `صياغة أسئلة مراجعة للامتحان (${mcqCount} اختياري + ${essayCount} مقالي)...`
        );

        // Build representative lecture digest across all pages
        const digest = allPages
          .map((p) => `[Slide ${p.index}]: ${p.text}`)
          .filter((t) => t.length > 15)
          .join('\n\n')
          .slice(0, 35000);

        try {
          const res = await fetchWithTimeout('/api/generate-questions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contentDigest: digest,
              mcqCount,
              essayCount,
              difficulty,
            }),
          }, API_TIMEOUT_MS);

          if (res.ok) {
            const qData = await res.json();
            setMcqs(Array.isArray(qData.mcqs) ? qData.mcqs : []);
            setEssays(Array.isArray(qData.essays) ? qData.essays : []);
          }
        } catch (qErr) {
          console.error('Questions generation error:', qErr);
        }
      }

      setProgressPercent(100);
      setCurrentProgressPhase('اكتمل توليد الدليل الدراسي بنجاح!');
      setStatusMessage('🎉 تم تجهيز الدليل الدراسي والشرح المصري وأسئلة الامتحان بنجاح!');
      stopGenerationTimer();
    } catch (err: any) {
      console.error(err);
      setStatusMessage(`❌ حدث خطأ: ${err?.message || 'تعذر الإكمال'}`);
      stopGenerationTimer();
    } finally {
      setIsProcessing(false);
    }
  };

  const capturePreviewToPdf = async (fileLabel: string) => {
    const previewRoot = previewRef.current || document.querySelector('[data-pdf-export-root="true"]') as HTMLElement | null;
    if (!previewRoot) return false;
    const slideGroupsToExport = Array.from(previewRoot.querySelectorAll('[data-export-group="true"]')) as HTMLElement[];
    const questionsToExport = Array.from(
      previewRoot.querySelectorAll('[data-export-page-kind="mcq"], [data-export-page-kind="essay"]')
    ) as HTMLElement[];
    const mcqsToExport = Array.from(previewRoot.querySelectorAll('[data-export-page-kind="mcq"]')) as HTMLElement[];
    const essaysToExport = Array.from(previewRoot.querySelectorAll('[data-export-page-kind="essay"]')) as HTMLElement[];
    const pagesToExport: Array<{ elements: HTMLElement[]; content: 'slides' | 'questions' | 'answers' | 'full' }> =
      slideGroupsToExport.map((group) => ({ elements: [group], content: 'slides' }));

    for (let questionIndex = 0; questionIndex < questionsToExport.length; questionIndex += 3) {
      pagesToExport.push({ elements: questionsToExport.slice(questionIndex, questionIndex + 3), content: 'questions' });
    }

    if (showAnswers) {
      for (const questionSet of [mcqsToExport, essaysToExport]) {
        for (let answerIndex = 0; answerIndex < questionSet.length; answerIndex += 3) {
          pagesToExport.push({ elements: questionSet.slice(answerIndex, answerIndex + 3), content: 'answers' });
        }
      }
    }

    if (pagesToExport.length === 0) pagesToExport.push({ elements: [previewRoot], content: 'full' });

    const pdf = new jsPDF({
      orientation: 'p',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const exportColorContext = document.createElement('canvas').getContext('2d');

    for (let index = 0; index < pagesToExport.length; index++) {
      if (index > 0) pdf.addPage();

      const { elements: pageElements, content: pageContent } = pagesToExport[index];
      const element = pageElements[0];
      const captureWidth = Math.max(320, ...pageElements.map((item) => Math.ceil(item.getBoundingClientRect().width)));
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      iframe.style.position = 'fixed';
      iframe.style.left = '-9999px';
      iframe.style.top = '-9999px';
      iframe.style.width = `${captureWidth}px`;
      iframe.style.height = '1200px';
      iframe.style.border = '0';
      document.body.appendChild(iframe);

      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;

        const pageElementClones = pageElements.map((item) => item.cloneNode(true) as HTMLElement);
        const isQuestionPage = pageContent === 'questions' || pageContent === 'answers';
        const clone = pageElementClones.length === 1 && !isQuestionPage ? pageElementClones[0] : doc.createElement('div');
        if (isQuestionPage) {
          clone.dataset.exportPage = 'true';
          clone.dataset.exportPageMode = pageContent;
          const pageKinds = new Set(pageElements.map((pageElement) => pageElement.dataset.exportPageKind));
          clone.dataset.exportTitle = pageContent === 'answers'
            ? 'الإجابات والتفسيرات'
            : pageKinds.size > 1 ? 'أسئلة المراجعة' : pageKinds.has('essay') ? 'الأسئلة المقالية' : 'أسئلة الاختيار من متعدد';
          clone.dataset.exportSubtitle = `الأسئلة ${element.dataset.exportNumber} إلى ${pageElements[pageElements.length - 1].dataset.exportNumber}`;
          pageElementClones.forEach((pageElementClone) => clone.appendChild(pageElementClone));
        }
        clone.className = 'export-capture-root';
        clone.style.cssText = [
          `width: ${captureWidth}px`,
          `max-width: ${captureWidth}px`,
          'background: #ffffff',
          'color: #0f172a',
          'direction: rtl',
          'text-align: right',
          'font-family: Amiri, Tahoma, "Segoe UI", sans-serif',
          'padding: 0',
          'margin: 0',
          'box-sizing: border-box',
          'overflow: visible'
        ].join('; ');

        const sourceElements = pageElements.flatMap((item) => [item, ...Array.from(item.querySelectorAll('*'))]) as HTMLElement[];
        const clonedElements = pageElementClones.flatMap((item) => [item, ...Array.from(item.querySelectorAll('*'))]) as HTMLElement[];
        sourceElements.forEach((source, elementIndex) => {
          const item = clonedElements[elementIndex];
          const computedStyle = window.getComputedStyle(source);
          for (let styleIndex = 0; styleIndex < computedStyle.length; styleIndex++) {
            const property = computedStyle.item(styleIndex);
            if (property === 'height' || property === 'min-height' || property === 'max-height') continue;
            let value = computedStyle.getPropertyValue(property);
            if (/oklch|oklab|color\(/i.test(value) && exportColorContext) {
              value = value.replace(/(?:oklch|oklab|color)\([^)]*\)/gi, (colorValue) => {
                exportColorContext.fillStyle = '#000000';
                exportColorContext.fillStyle = colorValue;
                return exportColorContext.fillStyle;
              });
            }
            if (/oklch|oklab|color\(/i.test(value)) continue;
            item.style.setProperty(property, value);
          }
        });

        if (pageContent === 'questions') {
          pageElementClones.forEach((card) => {
            card.querySelectorAll('[data-pdf-answer-detail="true"]').forEach((detail) => detail.remove());
          });
        } else if (pageContent === 'answers') {
          pageElementClones.forEach((card) => {
            card.querySelectorAll('[data-pdf-question="true"], [data-pdf-options="true"]').forEach((prompt) => prompt.remove());
          });
        }

        const exportTitle = clone.dataset.exportTitle || element.dataset.exportTitle;
        const exportSubtitle = clone.dataset.exportSubtitle || element.dataset.exportSubtitle;
        if (exportTitle) {
          const heading = document.createElement('div');
          heading.style.cssText = 'direction:rtl;text-align:right;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #cbd5e1;font-family:Amiri,Tahoma,"Segoe UI",sans-serif';

          const title = document.createElement('div');
          title.textContent = exportTitle;
          title.style.cssText = 'font-size:18px;line-height:1.3;font-weight:700;color:#0f172a;direction:rtl;text-align:right';
          heading.appendChild(title);

          if (exportSubtitle) {
            const subtitle = document.createElement('div');
            subtitle.textContent = exportSubtitle;
            subtitle.style.cssText = 'margin-top:2px;font-size:12px;line-height:1.3;color:#047857;direction:rtl;text-align:right';
            heading.appendChild(subtitle);
          }

          clone.insertBefore(heading, clone.firstChild);
        }

        clone.style.setProperty('width', `${captureWidth}px`, 'important');
        clone.style.setProperty('max-width', `${captureWidth}px`, 'important');
        clone.style.setProperty('margin', '0', 'important');
        clone.style.setProperty('overflow', 'visible', 'important');

        doc.open();
        doc.write(`<!doctype html><html><head>
          <meta charset="utf-8" />
          <style>
            @font-face { font-family: 'Amiri'; src: url('/fonts/Amiri-Regular.ttf') format('truetype'); }
            html, body { margin: 0; padding: 0; background: #fff; font-family: 'Amiri', Tahoma, 'Segoe UI', sans-serif; direction: rtl; text-align: right; }
            body { width: ${captureWidth}px; }
            .export-capture-root { width: ${captureWidth}px; max-width: ${captureWidth}px; background: #fff; color: #0f172a; direction: rtl; text-align: right; font-family: 'Amiri', Tahoma, 'Segoe UI', sans-serif; }
            .export-capture-root[data-export-group="true"] { padding: 8px !important; }
            .export-capture-root[data-export-group="true"] > div:first-child { padding-top: 8px !important; padding-bottom: 8px !important; margin-bottom: 8px !important; }
            .export-capture-root[data-export-group="true"] .grid { gap: 6px !important; margin-bottom: 8px !important; }
            .export-capture-root[data-export-group="true"] .grid > div { min-width: 0 !important; padding: 4px !important; }
            .export-capture-root[data-export-group="true"] .grid > div > .w-full { width: 100% !important; max-width: 100% !important; }
            .export-capture-root [data-pdf-slide-image="true"] { display: block; width: 100% !important; height: auto !important; max-height: none !important; margin: 0 auto !important; object-fit: contain !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl { padding: 8px !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl h3,
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl h4 { margin-bottom: 6px !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"], .export-capture-root[data-export-group="true"] [dir="rtl"] * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl p,
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl li { font-size: 12px !important; line-height: 1.4 !important; white-space: normal !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl h3 { line-height: 1.4 !important; white-space: normal !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl span { white-space: nowrap !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl ul { margin-top: 6px !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl li { padding: 5px !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl .mt-4 { margin-top: 8px !important; }
            .export-capture-root[data-export-group="true"] [dir="rtl"].rounded-2xl .mb-4 { margin-bottom: 8px !important; }
            .export-capture-root[data-export-page="true"] { padding: 8px !important; width: 100% !important; max-width: 100% !important; }
            .export-capture-root[data-export-page="true"] > [data-export-page="true"] { margin: 0 0 5px !important; padding: 7px !important; }
            .export-capture-root[data-export-page="true"] > [data-export-page="true"] > div:first-child { margin-bottom: 5px !important; }
            .export-capture-root[data-export-page-mode="questions"] > [data-export-page="true"] p { font-size: 14px !important; line-height: 1.35 !important; white-space: normal !important; overflow-wrap: anywhere !important; }
            .export-capture-root[data-export-page-mode="questions"] > [data-export-page="true"] button { padding: 6px !important; font-size: 12px !important; line-height: 1.25 !important; }
            .export-capture-root[data-export-page-mode="questions"] > [data-export-page="true"] .p-2\.5 { padding: 5px !important; }
            .export-capture-root[data-export-page-mode="answers"] p,
            .export-capture-root[data-export-page-mode="answers"] li { font-size: 11px !important; line-height: 1.3 !important; white-space: normal !important; overflow-wrap: anywhere !important; }
            .export-capture-root[data-export-page-mode="answers"] .whitespace-pre-line { font-size: 11px !important; line-height: 1.3 !important; }
            .export-capture-root[data-export-page-mode="answers"] .mt-3,
            .export-capture-root[data-export-page-mode="answers"] .mt-4 { margin-top: 5px !important; padding-top: 5px !important; }
            .export-capture-root[data-export-page-mode="answers"] .p-3,
            .export-capture-root[data-export-page-mode="answers"] .p-3\.5,
            .export-capture-root[data-export-page-mode="answers"] .p-4 { padding: 6px !important; }
            .export-capture-root[data-export-page-mode="answers"] .space-y-2 > :not([hidden]) ~ :not([hidden]),
            .export-capture-root[data-export-page-mode="answers"] .space-y-2\.5 > :not([hidden]) ~ :not([hidden]) { margin-top: 4px !important; }
            .export-capture-root[data-export-page="true"] .question-layout { display: block !important; }
            .export-capture-root[data-export-page="true"] .question-column, .export-capture-root[data-export-page="true"] .answer-column { width: 100% !important; max-width: 100% !important; }
            .export-capture-root[data-export-page="true"] .question-column { direction: ltr !important; text-align: left !important; }
            .export-capture-root[data-export-page="true"] .answer-column { direction: rtl !important; text-align: right !important; margin-top: 18px !important; padding-top: 14px !important; border-top: 1px solid #cbd5e1 !important; }
            .export-capture-root[data-export-page="true"] .question-column > div { font-size: 17px !important; line-height: 1.6 !important; }
            .export-capture-root[data-export-page="true"] .question-column li { font-size: 15px !important; line-height: 1.6 !important; }
            .export-capture-root[data-export-page="true"] .answer-column > div { font-size: 15px !important; }
            .export-capture-root[data-export-page="true"] .answer-column p { font-size: 15px !important; line-height: 1.7 !important; }
            * { box-sizing: border-box; }
          </style>
        </head><body>${clone.outerHTML}</body></html>`);
        doc.close();

        const renderTarget = doc.body.querySelector('.export-capture-root') as HTMLElement | null;
        if (!renderTarget) continue;

        await doc.fonts.load('12px Amiri');
        await doc.fonts.ready;
        await Promise.all(Array.from(renderTarget.querySelectorAll('img')).map((img) => {
          const image = img as HTMLImageElement;
          return image.decode().catch(() => undefined);
        }));

        const renderWidth = Math.ceil(Math.max(renderTarget.getBoundingClientRect().width, renderTarget.scrollWidth));
        const renderHeight = Math.ceil(Math.max(renderTarget.getBoundingClientRect().height, renderTarget.scrollHeight));

        const canvas = await html2canvas(renderTarget, {
          scale: 2,
          backgroundColor: '#ffffff',
          useCORS: true,
          allowTaint: true,
          scrollX: 0,
          scrollY: 0,
          width: renderWidth,
          height: renderHeight,
          windowWidth: renderWidth,
          windowHeight: renderHeight,
          logging: false,
        });

        const imgData = canvas.toDataURL('image/png');
        const imgProps = pdf.getImageProperties(imgData);
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = pageHeight - margin * 2;
        const ratio = Math.min(maxWidth / imgProps.width, maxHeight / imgProps.height);
        const imgWidth = Math.min(imgProps.width * ratio, maxWidth);
        const imgHeight = Math.min(imgProps.height * ratio, maxHeight);
        const x = (pageWidth - imgWidth) / 2;
        const y = (pageHeight - imgHeight) / 2;

        pdf.addImage(imgData, 'PNG', x, y, imgWidth, imgHeight, undefined, 'FAST');
      } finally {
        iframe.remove();
      }
    }

    const pdfBlob = pdf.output('blob');
    const downloadUrl = URL.createObjectURL(pdfBlob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${fileLabel || PREVIEW_DOC_TITLE}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);

    return true;
  };

  const handleDownloadPdf = async () => {
    setIsExportingPdf(true);
    setStatusMessage('⏳ جاري تجهيز PDF النهائي...');

    try {
      const fileNamePrefix = (selectedFile?.name || 'study-guide').replace(/\.[^.]+$/i, '');
      const previewRoot = previewRef.current || document.querySelector('[data-pdf-export-root="true"]') as HTMLElement | null;

      if (previewRoot && (slideGroups.length > 0 || mcqs.length > 0 || essays.length > 0 || Boolean(audioResult))) {
        try {
          const captured = await capturePreviewToPdf(fileNamePrefix || PREVIEW_DOC_TITLE);
          if (captured) {
            setStatusMessage('📥 تم تنزيل ملف PDF مطابق للمعاينة الحالية بنجاح!');
            return;
          }
        } catch (previewError) {
          console.warn('Preview capture failed; using the export-copy fallback:', previewError);
        }
      }

      if (!previewRoot) {
        throw new Error('لا توجد معاينة جاهزة للتصدير');
      }

      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'mm',
        format: 'a4',
        compress: true,
      });

      await ensureArabicPdfFont(pdf);
      pdf.setFont('Amiri', 'normal');

      const pageWidth = 210;
      const pageHeight = 297;
      const marginX = 8;
      const marginTop = 8;
      const lineHeight = 6.2;

      const pdfText = (text: string, x: number, y: number, options?: { align?: 'left' | 'center' | 'right'; maxWidth?: number }) => {
        const normalized = normalizeArabicForPdf(String(text || ''));
        pdf.setFont('Amiri', 'normal');
        pdf.text(normalized, x, y, options);
      };

      const addWrappedText = (text: string, x: number, y: number, maxWidth: number, startNewPage = false, align: 'left' | 'right' = 'left') => {
        const cleanText = normalizeArabicForPdf(String(text || ''));
        if (!cleanText) return y;

        const lines = pdf.splitTextToSize(cleanText, maxWidth);
        let cursorY = y;

        for (const line of lines) {
          if (cursorY > pageHeight - 16) {
            pdf.addPage();
            cursorY = marginTop;
          }
          pdfText(line, x, cursorY, { align });
          cursorY += lineHeight;
        }

        return cursorY + (startNewPage ? 2 : 0);
      };

      const addFooter = (pageNumber: number, totalPages: number) => {
        pdf.setPage(pageNumber);
        pdf.setFontSize(8);
        pdf.setTextColor(100, 116, 139);
        pdfText(`دليل المذاكرة الأكاديمي | ${selectedFile?.name || 'Study Guide'}`, pageWidth - marginX, 8, { align: 'right' });
        pdfText(`صفحة ${pageNumber} من ${totalPages}`, pageWidth / 2, pageHeight - 5, { align: 'center' });
      };

      const hasContent = slideGroups.length > 0 || mcqs.length > 0 || essays.length > 0 || Boolean(audioResult);
      if (!hasContent) {
        throw new Error('لا يوجد محتوى جاهز لتصديره إلى PDF');
      }

      let pageCursor = 0;
      const startNewContentPage = () => {
        if (pageCursor > 0) pdf.addPage();
        pageCursor += 1;
      };

      if (audioResult) {
        startNewContentPage();
        let y = marginTop;
        pdf.setFontSize(19);
        pdf.setTextColor(88, 28, 135);
        pdfText(audioResult.title || 'محاضرة مسجلة', marginX, y);
        y += 12;

        pdf.setFontSize(11.5);
        pdf.setTextColor(51, 65, 85);
        pdfText(`الملف: ${audioResult.fileName}`, marginX, y);
        y += 14;

        if (audioResult.keyTakeaways && audioResult.keyTakeaways.length > 0) {
          pdf.setFontSize(13);
          pdf.setTextColor(30, 41, 59);
          pdfText('أهم النقاط المستخلصة من المحاضرة', marginX, y);
          y += 9;
          pdf.setFontSize(10.5);
          pdf.setTextColor(51, 65, 85);
          audioResult.keyTakeaways.forEach((item) => {
            if (y > pageHeight - 18) {
              pdf.addPage();
              y = marginTop;
            }
            y = addWrappedText(`• ${item}`, marginX, y, pageWidth - marginX * 2);
          });
          y += 6;
        }

        pdf.setFontSize(13);
        pdf.setTextColor(15, 23, 42);
        pdfText('أقسام وتفاصيل المحاضرة', marginX, y);
        y += 9;

        audioResult.sections.forEach((section, idx) => {
          if (y > pageHeight - 70) {
            pdf.addPage();
            y = marginTop;
          }

          pdf.setFontSize(12);
          pdf.setTextColor(17, 24, 39);
          pdfText(`${idx + 1}. ${section.heading}`, marginX, y);
          y += 8;

          pdf.setFontSize(10.5);
          pdf.setTextColor(51, 65, 85);
          y = addWrappedText(section.body || '', marginX, y, pageWidth - marginX * 2);
          y += 4;

          if (section.points && section.points.length > 0) {
            section.points.forEach((point) => {
              y = addWrappedText(`- ${point}`, marginX + 4, y, pageWidth - marginX * 2 - 6);
            });
          }

          if (section.doctorTipAr) {
            y += 3;
            y = addWrappedText(`💡 ملاحظة مراجعة: ${section.doctorTipAr}`, marginX, y, pageWidth - marginX * 2);
          }

          y += 6;
        });

        if (audioResult.transcript) {
          pdf.addPage();
          let transcriptY = marginTop;
          pdf.setFontSize(13);
          pdf.setTextColor(15, 23, 42);
          pdfText('التفريغ الكامل للمحاضرة', marginX, transcriptY);
          transcriptY += 11;
          pdf.setFontSize(9.5);
          pdf.setTextColor(51, 65, 85);
          const transcriptLines = pdf.splitTextToSize(normalizeArabicForPdf(audioResult.transcript || ''), pageWidth - marginX * 2);
          transcriptLines.forEach((line: string) => {
            if (transcriptY > pageHeight - 12) {
              pdf.addPage();
              transcriptY = marginTop;
            }
            pdfText(line, marginX, transcriptY);
            transcriptY += 4.5;
          });
        }
      }

      if (slideGroups.length > 0) {
        slideGroups.forEach((group) => {
          if (pageCursor > 0) pdf.addPage();
          pageCursor += 1;
          let y = marginTop;
          const colGap = 6;
          const colWidth = (pageWidth - marginX * 2 - colGap) / 2;

          pdf.setFontSize(16);
          pdf.setTextColor(15, 23, 42);
          pdfText(
            group.startSlide === group.endSlide
              ? `شريحة ${group.startSlide}`
              : `الشرائح ${group.startSlide} إلى ${group.endSlide}`,
            pageWidth - marginX,
            y,
            { align: 'right' }
          );
          y += 9;

          const slidesToRender = group.pages.slice(0, 4);
          slidesToRender.forEach((page, idx) => {
            const isRightColumn = idx % 2 === 1;
            const x = marginX + (isRightColumn ? colWidth + colGap : 0);
            const rowIndex = Math.floor(idx / 2);
            const currentY = y + rowIndex * 89;

            pdf.setFontSize(8.5);
            pdf.setTextColor(71, 85, 105);
            pdfText(`Slide ${page.index}`, x, currentY);

            if (page.img) {
              try {
                const imageHeight = 42;
                pdf.addImage(page.img, 'JPEG', x, currentY + 4, colWidth, imageHeight, undefined, 'FAST');
              } catch {
                pdf.setFillColor(241, 245, 249);
                pdf.rect(x, currentY + 4, colWidth, 42, 'F');
                pdf.setTextColor(100, 116, 139);
                pdfText('Slide image unavailable', x + 6, currentY + 25);
              }
            }

            if (page.text) {
              const textY = currentY + 49;
              pdf.setTextColor(51, 65, 85);
              const textLines = pdf.splitTextToSize(normalizeArabicForPdf(page.text), colWidth - 1);
              const maxTextLines = 5;
              textLines.slice(0, maxTextLines).forEach((line: string, lineIndex: number) => {
                pdfText(line, x, textY + lineIndex * 4.4);
              });
            }
          });

          const explanationStartY = y + Math.ceil(slidesToRender.length / 2) * 89 + 8;
          if (group.explanation) {
            pdf.setFontSize(12);
            pdf.setTextColor(16, 185, 129);
            pdfText(group.explanation.topic || 'شرح السلايد', pageWidth - marginX, explanationStartY, { align: 'right' });

            pdf.setFontSize(9.5);
            pdf.setTextColor(51, 65, 85);
            let explanationY = explanationStartY + 7;

            if (group.explanation.conceptSummary) {
              explanationY = addWrappedText(`الفكرة الجوهرية: ${group.explanation.conceptSummary}`, pageWidth - marginX, explanationY, pageWidth - marginX * 2, false, 'right');
              explanationY += 1;
            }

            for (const paragraph of group.explanation.paragraphs || []) {
              explanationY = addWrappedText(paragraph, pageWidth - marginX, explanationY, pageWidth - marginX * 2, false, 'right');
              explanationY += 1;
            }

            if (group.explanation.doctorTips && group.explanation.doctorTips.length > 0) {
              explanationY += 2;
              pdf.setFontSize(9);
              pdf.setTextColor(146, 64, 14);
              pdfText('تريكات الامتحان', pageWidth - marginX, explanationY, { align: 'right' });
              explanationY += 5;
              pdf.setTextColor(51, 65, 85);
              for (const tip of group.explanation.doctorTips) {
                explanationY = addWrappedText(`• ${tip}`, pageWidth - marginX, explanationY, pageWidth - marginX * 2 - 3, false, 'right');
              }
            }
          }
        });
      }

      if ((mcqs.length > 0 || essays.length > 0) && slideGroups.length === 0) {
        if (pageCursor > 0) pdf.addPage();
        pageCursor += 1;
      }

      if (mcqs.length > 0 || essays.length > 0) {
        if (pageCursor > 0) pdf.addPage();
        pageCursor += 1;
        let y = marginTop;
        pdf.setFontSize(16);
        pdf.setTextColor(15, 23, 42);
        pdfText('أسئلة الامتحان', marginX, y);
        y += 10;
      }

      if (mcqs.length > 0) {
        let y = marginTop + 10;
        pdf.setFontSize(14);
        pdf.setTextColor(15, 23, 42);
        pdfText('أسئلة الاختيار من متعدد', marginX, y);
        y += 10;

        mcqs.forEach((q, idx) => {
          if (y > pageHeight - 60) {
            pdf.addPage();
            y = marginTop;
          }

          pdf.setFontSize(11);
          pdf.setTextColor(15, 23, 42);
          y = addWrappedText(`${idx + 1}. ${q.question}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          y += 3;

          pdf.setFontSize(9);
          pdf.setTextColor(51, 65, 85);
          q.options.forEach((option) => {
            y = addWrappedText(option, pageWidth - marginX, y, pageWidth - marginX * 2 - 6, false, 'right');
          });
          y += 4;

          if (q.answer) {
            y = addWrappedText(`الإجابة الصحيحة: ${q.answer}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          }
          if (q.explanation) {
            y = addWrappedText(`الشرح: ${q.explanation}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          }
          if (q.doctorNoteAr) {
            y = addWrappedText(`ملاحظة مراجعة: ${q.doctorNoteAr}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          }
          y += 8;
        });
      }

      if (essays.length > 0) {
        pdf.addPage();
        let y = marginTop;
        pdf.setFontSize(16);
        pdf.setTextColor(15, 23, 42);
        pdfText('الأسئلة المقالية', marginX, y);
        y += 10;

        essays.forEach((essay, idx) => {
          if (y > pageHeight - 60) {
            pdf.addPage();
            y = marginTop;
          }

          pdf.setFontSize(11);
          pdf.setTextColor(15, 23, 42);
          y = addWrappedText(`${idx + 1}. ${essay.question}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          y += 4;

          pdf.setFontSize(9);
          pdf.setTextColor(51, 65, 85);
          y = addWrappedText('الإجابة النموذجية:', pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          y = addWrappedText(essay.answer || '', pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          if (essay.rubricPoints && essay.rubricPoints.length > 0) {
            y = addWrappedText('مؤشرات التقييم:', pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
            essay.rubricPoints.forEach((point) => {
              y = addWrappedText(`• ${point}`, pageWidth - marginX, y, pageWidth - marginX * 2 - 4, false, 'right');
            });
          }
          if (essay.doctorNoteAr) {
            y = addWrappedText(`ملاحظة مراجعة: ${essay.doctorNoteAr}`, pageWidth - marginX, y, pageWidth - marginX * 2, false, 'right');
          }
          y += 8;
        });
      }

      const totalPages = pdf.getNumberOfPages();
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        addFooter(pageNumber, totalPages);
      }

      const pdfBlob = pdf.output('blob');
      const downloadUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${PREVIEW_DOC_TITLE}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      setStatusMessage('📥 تم تنزيل الملف النهائي PDF يحتوي على الشرائح، الشرح، والأسئلة بنجاح!');
    } catch (e: any) {
      console.error('PDF generation error:', e);
      setStatusMessage('⚠️ تعذر إنشاء PDF النهائي. حاول مرة أخرى بعد التحقق من وجود محتوى في المعاينة.');
    } finally {
      setIsExportingPdf(false);
    }
  };

  // Export Text File
  const handleDownloadTxt = () => {
    let plain = `========================================================\n`;
    plain += `   دليل المذاكرة والشرح الأكاديمي بالعامية المصرية\n`;
    plain += `   الملف: ${selectedFile?.name || 'Study Guide'}\n`;
    plain += `   تاريخ الإنشاء: ${new Date().toLocaleString('ar-EG')}\n`;
    plain += `========================================================\n\n`;

    if (mode === 'audio' && audioResult) {
      plain += `===== تفريغ وملاحظات المحاضرة =====\n\n`;
      plain += `العنوان: ${audioResult.title}\n\n`;
      audioResult.sections.forEach((sec, idx) => {
        plain += `--- [${idx + 1}] ${sec.heading} ---\n`;
        plain += `${sec.body}\n`;
        if (sec.points) {
          sec.points.forEach((pt) => (plain += `• ${pt}\n`));
        }
        if (sec.doctorTipAr) {
          plain += `ملاحظة مراجعة: ${sec.doctorTipAr}\n`;
        }
        plain += `\n`;
      });
      plain += `\n===== التفريغ الكامل =====\n${audioResult.transcript}\n`;
    } else {
      slideGroups.forEach((g) => {
        plain += `========================================================\n`;
        plain += `السلايد ${g.startSlide} إلى ${g.endSlide}: ${g.explanation?.topic || ''}\n`;
        plain += `========================================================\n`;
        if (g.explanation?.conceptSummary) {
          plain += `الفكرة الجوهرية: ${g.explanation.conceptSummary}\n\n`;
        }
        g.explanation?.paragraphs.forEach((p) => {
          plain += `${p}\n\n`;
        });
        if (g.explanation?.doctorTips && g.explanation.doctorTips.length > 0) {
          plain += `تركات وملاحظات الامتحان:\n`;
          g.explanation.doctorTips.forEach((tip) => (plain += `* ${tip}\n`));
          plain += `\n`;
        }
      });

      if (mcqs.length > 0) {
        plain += `\n========================================================\n`;
        plain += `أسئلة امتحانات الجامعة (اختيار من متعدد - MCQs)\n`;
        plain += `========================================================\n\n`;
        mcqs.forEach((q, idx) => {
          plain += `س${idx + 1}: ${q.question} [${q.difficulty || 'Normal'}]\n`;
          q.options.forEach((opt) => (plain += `   ${opt}\n`));
          plain += `   الإجابة الصحيحة: ${q.answer}\n`;
          if (q.explanation) plain += `   الشرح والتعليل: ${q.explanation}\n`;
          if (q.doctorNoteAr) plain += `   ملاحظة مراجعة: ${q.doctorNoteAr}\n`;
          plain += `\n`;
        });
      }

      if (essays.length > 0) {
        plain += `\n========================================================\n`;
        plain += `أسئلة امتحانات الجامعة (الأسئلة المقالية)\n`;
        plain += `========================================================\n\n`;
        essays.forEach((eq, idx) => {
          plain += `س${idx + 1}: ${eq.question}\n`;
          plain += `الإجابة النموذجية:\n${eq.answer}\n`;
          if (eq.doctorNoteAr) plain += `نصيحة المراجعة: ${eq.doctorNoteAr}\n`;
          plain += `\n`;
        });
      }
    }

    const blob = new Blob(['\ufeff' + plain], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(selectedFile?.name || 'study-guide').replace(/\.[^.]+$/, '')}-Notes.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderGeneratedPreview = () => {
    if (mode === 'full') {
      return (
        <div ref={previewRef} className="space-y-6">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h3 className="font-extrabold text-slate-900 text-base">معاينة PDF النهائية</h3>
            <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full border border-emerald-200">
              A4 Preview
            </span>
          </div>

          {slideGroups.length > 0 && slideGroups.map((group, gIdx) => (
            <div key={group.id} data-export-group="true" className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
              <div className="flex items-center justify-between bg-slate-50 border-b border-slate-200 px-4 py-3">
                <span className="text-xs font-bold text-slate-700" style={arabicTitleStyle}>
                  {group.startSlide === group.endSlide ? `شريحة ${group.startSlide}` : `الشرائح ${group.startSlide} إلى ${group.endSlide}`}
                </span>
                <span className="text-[10px] text-slate-500">صفحة {gIdx + 1}</span>
              </div>

              <div className="p-4">
                <div className="grid gap-4 md:grid-cols-2" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                  {group.pages.map((page) => (
                    <div key={page.index} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                      <div className="text-[10px] font-bold text-slate-500 mb-2" style={arabicTitleStyle}>Slide #{page.index}</div>
                      {page.img ? (
                        <img data-pdf-slide-image="true" src={page.img} alt={`Slide ${page.index}`} className="w-full h-[280px] md:h-[340px] object-contain rounded-xl border border-slate-200 bg-white" />
                      ) : (
                        <div className="flex h-[280px] md:h-[340px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-xs text-slate-400" style={arabicTitleStyle}>
                          لا توجد صورة
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {group.explanation && (
                  <div dir="rtl" className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                    <div className="text-sm font-extrabold text-emerald-900 mb-2" style={arabicTitleStyle}>{group.explanation.topic}</div>
                    {group.explanation.conceptSummary && (
                      <p className="text-xs text-emerald-800 mb-2 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>{group.explanation.conceptSummary}</p>
                    )}
                    <div className="space-y-2 text-xs text-slate-700 leading-relaxed" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                      {group.explanation.paragraphs?.slice(0, 3).map((paragraph, idx) => (
                        <p key={idx} style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>{paragraph}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {(mcqs.length > 0 || essays.length > 0) && (
            <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
              <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 text-sm font-bold text-amber-900 study-guide-title" style={arabicTitleStyle}>أسئلة المراجعة</div>

              <div className="p-4 space-y-4">
                {mcqs.map((q, idx) => (
                  <div key={`mcq-${idx}`} data-export-page="true" data-export-title="أسئلة المراجعة" data-export-subtitle={`سؤال اختيار من متعدد ${idx + 1}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 pdf-export-card" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                    <div className="question-layout">
                      <div className="question-column">
                        <div className="text-sm font-bold text-slate-900 mb-2">{idx + 1}. {q.question}</div>
                        <ul className="space-y-1 text-xs text-slate-700">
                          {q.options.map((option, optIdx) => (<li key={optIdx}>{option}</li>))}
                        </ul>
                      </div>

                      <div className="answer-column">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 mb-2">الشرح</div>
                        {q.answer && <p className="text-xs text-slate-700 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}><strong>الإجابة الصحيحة: </strong>{q.answer}</p>}
                        {q.explanation && <p className="mt-2 text-xs text-slate-700 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}><strong>التفسير: </strong>{q.explanation}</p>}
                        {q.doctorNoteAr && <p className="mt-2 text-xs text-amber-900 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}><strong>ملاحظة الدكتور: </strong>{q.doctorNoteAr}</p>}
                      </div>
                    </div>
                  </div>
                ))}

                {essays.map((essay, idx) => (
                    <div key={`essay-${idx}`} data-export-page="true" data-export-title="الأسئلة المقالية النموذجية" data-export-subtitle={`السؤال المقالي ${idx + 1}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 pdf-export-card" dir="rtl" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>
                    <div className="question-layout">
                      <div className="question-column">
                        <div className="text-sm font-bold text-slate-900 mb-2">{idx + 1}. {essay.question}</div>
                      </div>

                      <div className="answer-column">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 mb-2">الإجابة</div>
                        <p className="text-xs text-slate-700 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>{essay.answer || '—'}</p>
                        {essay.rubricPoints?.map((point, pointIdx) => (
                          <p key={pointIdx} className="mt-2 text-xs text-slate-700 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}>{point}</p>
                        ))}
                        {essay.doctorNoteAr && <p className="mt-2 text-xs text-amber-900 leading-relaxed" style={{ ...rtlArabicTextStyle, textAlign: 'right' }}><strong>نصيحة المراجعة: </strong>{essay.doctorNoteAr}</p>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (mode === 'audio' && audioResult) {
      return (
        <div ref={previewRef} className="space-y-5">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h3 className="font-extrabold text-slate-900 text-base">معاينة PDF المحاضرة</h3>
            <span className="text-[10px] font-bold bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full border border-purple-200">
              A4 PDF
            </span>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden" dir="rtl" style={{ textAlign: 'right', direction: 'rtl' }}>
            <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 text-sm font-bold text-slate-700">{audioResult.title}</div>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl border border-purple-200 bg-purple-50/60 p-4">
                <div className="text-xs font-bold text-purple-800 mb-2">أهم النقاط</div>
                <ul className="list-disc pr-5 text-xs text-purple-900 space-y-1" style={{ direction: 'rtl', textAlign: 'right' }}>
                  {(audioResult.keyTakeaways || []).map((item, idx) => (<li key={idx}>{item}</li>))}
                </ul>
              </div>

              {audioResult.sections.map((section, idx) => (
                <div key={idx} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" dir="rtl" style={{ textAlign: 'right', direction: 'rtl' }}>
                  <div className="text-sm font-bold text-slate-900 mb-2">{section.heading}</div>
                  <p className="text-xs leading-relaxed text-slate-700" style={{ textAlign: 'right', direction: 'rtl' }}>{section.body}</p>
                  {section.points && section.points.length > 0 && (
                    <ul className="list-disc pr-5 text-xs text-slate-600 mt-2 space-y-1" style={{ direction: 'rtl', textAlign: 'right' }}>
                      {section.points.map((point, pIdx) => (<li key={pIdx}>{point}</li>))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (mode === 'questions' && (mcqs.length > 0 || essays.length > 0)) {
      return (
        <div ref={previewRef} className="space-y-5">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h3 className="font-extrabold text-slate-900 text-base">معاينة أسئلة الامتحان</h3>
            <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full border border-amber-200">
              Exam Preview
            </span>
          </div>

          <div className="space-y-4" dir="rtl" style={{ textAlign: 'right', direction: 'rtl' }}>
            {mcqs.map((q, idx) => (
              <div key={idx} className="rounded-2xl border border-slate-200 bg-white p-4" dir="rtl" style={{ textAlign: 'right', direction: 'rtl' }}>
                <div className="text-sm font-bold text-slate-900 mb-2">{idx + 1}. {q.question}</div>
                <ul className="space-y-1 text-xs text-slate-700" style={{ direction: 'rtl', textAlign: 'right' }}>
                  {q.options.map((option, optIdx) => (<li key={optIdx}>{option}</li>))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className={`min-h-screen bg-slate-50 text-slate-800 ${deviceView === 'mobile' ? 'max-w-md mx-auto p-2 border-x border-slate-200 shadow-2xl bg-white min-h-screen' : 'p-4 md:p-8'}`}>
      {/* Header */}
      <header className="no-print mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/30">
              <GraduationCap className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2" style={arabicTitleStyle}>
                Study Guide
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700 border border-emerald-200" style={arabicTitleStyle}>
                  <Sparkles className="h-3 w-3" /> شرح + مراجعة
                </span>
              </h1>
              <p className="text-xs md:text-sm text-slate-500 font-medium">
                تفريغ السلايدز، شرح مبسط، ومراجعة أسئلة الامتحان
              </p>
            </div>
          </div>
        </div>

        {/* View Switcher: Desktop vs Mobile */}
        <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-xl self-start md:self-auto">
          <button
            onClick={() => setDeviceView('desktop')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
              deviceView === 'desktop' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Monitor className="h-3.5 w-3.5" /> Desktop
          </button>
          <button
            onClick={() => setDeviceView('mobile')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
              deviceView === 'mobile' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Smartphone className="h-3.5 w-3.5" /> Mobile
          </button>
        </div>
      </header>

      {/* Mode Selector */}
      <div className="no-print mb-6 grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          onClick={() => setMode('full')}
          className={`flex items-start gap-3.5 p-4 rounded-2xl border-2 text-left transition-all ${
            mode === 'full'
              ? 'border-emerald-500 bg-emerald-50/50 shadow-md shadow-emerald-500/10'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <div className={`p-2.5 rounded-xl ${mode === 'full' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-900">Mode 1: Full Study Guide</span>
              <span className="text-[10px] uppercase tracking-wider bg-emerald-200/60 text-emerald-800 font-bold px-2 py-0.5 rounded-full">
                شامل
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              عرض كل السلايدز + شرح مبسط لكل شريحة + أسئلة مراجعة
            </p>
          </div>
        </button>

        <button
          onClick={() => setMode('questions')}
          className={`flex items-start gap-3.5 p-4 rounded-2xl border-2 text-left transition-all ${
            mode === 'questions'
              ? 'border-amber-500 bg-amber-50/50 shadow-md shadow-amber-500/10'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <div className={`p-2.5 rounded-xl ${mode === 'questions' ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
            <Flame className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-900">Mode 2: Questions Only</span>
              <span className="text-[10px] uppercase tracking-wider bg-amber-200/60 text-amber-800 font-bold px-2 py-0.5 rounded-full">
                سريع
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              استخراج فوري للنص وتوليد بنك أسئلة جامعية (MCQ + مقالي) بأسلوب مراجعة سريع
            </p>
          </div>
        </button>

        <button
          onClick={() => setMode('audio')}
          className={`flex items-start gap-3.5 p-4 rounded-2xl border-2 text-left transition-all ${
            mode === 'audio'
              ? 'border-purple-500 bg-purple-50/50 shadow-md shadow-purple-500/10'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <div className={`p-2.5 rounded-xl ${mode === 'audio' ? 'bg-purple-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
            <Mic className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-900">Mode 3: Audio to Notes</span>
              <span className="text-[10px] uppercase tracking-wider bg-purple-200/60 text-purple-800 font-bold px-2 py-0.5 rounded-full">
                تفريغ
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              تحويل تسجيل المحاضرة الصوتي إلى تفريغ ومذكرات دراسية منظمة بعناوين ونقاط
            </p>
          </div>
        </button>
      </div>

      {/* Main Control Panel */}
      <div className="no-print mb-6 rounded-3xl bg-white p-5 md:p-6 shadow-sm border border-slate-200">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-end">
          {/* File Upload Box */}
          <div className="lg:col-span-6">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <UploadCloud className="h-4 w-4 text-emerald-600" />
              {mode === 'audio' ? 'اختر تسجيل المحاضرة (Audio File)' : 'اختر ملف المحاضرة (PDF Slides)'}
            </label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-between gap-3 p-3.5 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/80 hover:bg-slate-100/80 cursor-pointer transition-all hover:border-emerald-500"
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white shadow-sm border border-slate-200 text-emerald-600">
                  {mode === 'audio' ? <Volume2 className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                </div>
                <div className="overflow-hidden">
                  <p className="text-sm font-bold text-slate-800 truncate">
                    {selectedFile ? selectedFile.name : mode === 'audio' ? 'اضغط لرفع ملف صوتي (MP3, WAV, M4A)...' : 'اضغط لاختيار ملف الـ PDF...'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {selectedFile
                      ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB ${filePageCount ? `· ${filePageCount} صفحة` : ''}`
                      : mode === 'audio'
                      ? 'يدعم حتى 100 ميجابايت'
                      : 'يدعم جميع أحجام السلايدز والمحاضرات'}
                  </p>
                </div>
              </div>
              <span className="flex-shrink-0 text-xs font-bold bg-white text-slate-700 px-3 py-1.5 rounded-xl border border-slate-200 shadow-sm">
                تصفح
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={mode === 'audio' ? 'audio/*,.mp3,.wav,.m4a,.webm,.mp4' : '.pdf,application/pdf'}
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* Mode Configuration Parameters */}
          {mode !== 'audio' ? (
            <div className="lg:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-2.5">
              {mode === 'full' && (
                <>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-sm">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                      شريحة / مجموعة
                    </label>
                    <select
                      value={slidesPerPage}
                      onChange={(e) => setSlidesPerPage(Number(e.target.value))}
                      className="w-full text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 py-2.5 focus:outline-none focus:border-emerald-500"
                    >
                      <option value={1}>1 شريحة</option>
                      <option value={2}>2 شريحة</option>
                      <option value={3}>3 شرائح</option>
                      <option value={4}>4 شرائح</option>
                    </select>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-sm">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                      شرائح للشرح
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={maxSlidesToExplain}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (!Number.isNaN(value)) {
                          setMaxSlidesToExplain(Math.min(100, Math.max(1, value)));
                        }
                      }}
                      className="w-full text-base font-bold bg-white border border-slate-200 rounded-xl px-2.5 py-2.5 focus:outline-none focus:border-emerald-500 text-center"
                    />
                  </div>
                </>
              )}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-sm">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                  أسئلة MCQ
                </label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={mcqCount}
                  onChange={(e) => setMcqCount(Number(e.target.value))}
                  className="w-full text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 py-2.5 focus:outline-none focus:border-emerald-500 text-center"
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-sm">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                  أسئلة مقالية
                </label>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={essayCount}
                  onChange={(e) => setEssayCount(Number(e.target.value))}
                  className="w-full text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 py-2.5 focus:outline-none focus:border-emerald-500 text-center"
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-sm">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                  مستوى الأسئلة
                </label>
                <select
                  value={difficulty}
                  onChange={(e: any) => setDifficulty(e.target.value)}
                  className="w-full text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 py-2.5 focus:outline-none focus:border-emerald-500"
                >
                  <option value="mixed">منوع</option>
                  <option value="easy">سهل</option>
                  <option value="medium">متوسط</option>
                  <option value="hard">صعب</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="lg:col-span-4 flex items-center text-xs text-purple-700 bg-purple-50 p-3 rounded-2xl border border-purple-200">
              <Sparkles className="h-4 w-4 mr-2 flex-shrink-0" />
              سيقوم الذكاء الاصطناعي بتفريغ الصوت وتحويله لمذكرات مجهزة بالعناوين ونقاط الامتحانات.
            </div>
          )}

          {/* Action Button */}
          <div className="lg:col-span-2">
            <button
              onClick={handleGenerate}
              disabled={!selectedFile || isProcessing}
              className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-2xl font-bold text-sm text-white shadow-lg transition-all ${
                isProcessing
                  ? 'bg-slate-400 cursor-not-allowed'
                  : !selectedFile
                  ? 'bg-slate-300 cursor-not-allowed'
                  : mode === 'questions'
                  ? 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/25'
                  : mode === 'audio'
                  ? 'bg-purple-600 hover:bg-purple-700 shadow-purple-600/25'
                  : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/25'
              }`}
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> جاري التوليد...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 fill-current" /> بدء التوليد
                </>
              )}
            </button>
          </div>
        </div>

        {/* Live Status Message & Time Limit Indicator */}
        {statusMessage && (
          <div className="mt-4 flex flex-col md:flex-row md:items-center justify-between text-xs font-semibold text-slate-600 bg-slate-50 p-3 rounded-xl border border-slate-200/80 gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>{statusMessage}</span>
            </div>
            {isProcessing && (
              <div className="flex items-center gap-4 text-slate-700 font-mono text-[11px]">
                <span className="flex items-center gap-1 text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md">
                  <Clock className="h-3 w-3" /> المنقضي: {formatTime(elapsedSeconds)}
                </span>
                <span className="flex items-center gap-1 text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded-md">
                  الحد الأقصى (8 دقائق): {formatTime(remainingSeconds)}
                </span>
                {isRecovering && (
                  <span className="flex items-center gap-1 text-red-700 bg-red-100 px-2 py-0.5 rounded-md font-bold animate-pulse">
                    فترة الاسترداد (2 دقيقة): {formatTime(recoveryRemainingSeconds)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Progress Card when generating */}
      {isProcessing && (
        <div className="no-print mb-6 rounded-3xl bg-slate-900 text-white p-6 shadow-xl relative overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                <Sparkles className="h-4 w-4" />
              </div>
              <h3 className="font-bold text-sm md:text-base">
                جاري المعالجة بواسطة الذكاء الاصطناعي...
              </h3>
            </div>
            <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-950 px-2.5 py-1 rounded-lg border border-emerald-800">
              {progressPercent}%
            </span>
          </div>

          <p className="text-xs text-slate-300 font-mono mb-4">{currentProgressPhase}</p>

          {/* Progress Bar */}
          <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 transition-all duration-300 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Timers info */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs text-slate-400">
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
              <p className="text-[10px] uppercase text-slate-400">الوقت المنقضي</p>
              <p className="font-mono text-base font-bold text-white mt-0.5">{formatTime(elapsedSeconds)}</p>
            </div>
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
              <p className="text-[10px] uppercase text-slate-400">الحد الأقصى للتوليد (8 دقائق)</p>
              <p className="font-mono text-base font-bold text-amber-400 mt-0.5">{formatTime(remainingSeconds)}</p>
            </div>
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700 col-span-2 md:col-span-1">
              <p className="text-[10px] uppercase text-slate-400">محرك الاسترداد والتصحيح</p>
              <p className="font-mono text-base font-bold text-emerald-400 mt-0.5">
                {isRecovering ? `نشط (${formatTime(recoveryRemainingSeconds)})` : 'مفعل وتلقائي (2 دقيقة)'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Results & Preview Header Bar */}
      {(slideGroups.length > 0 || mcqs.length > 0 || audioResult) && (
        <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
              <Eye className="h-4 w-4 text-emerald-600" /> استعراض المحتوى الكامل
            </span>
            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-bold">
              {slideGroups.length > 0 ? `${slideGroups.length} مجموعة سلايدز` : ''}
              {mcqs.length > 0 ? ` · ${mcqs.length} MCQ` : ''}
              {essays.length > 0 ? ` · ${essays.length} مقالي` : ''}
            </span>
          </div>

          {/* Action Downloads */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAnswers(!showAnswers)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition-all"
            >
              {showAnswers ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showAnswers ? 'إخفاء الإجابات للاختبار' : 'إظهار نموذج الإجابة'}
            </button>

            <button
              onClick={handleDownloadPdf}
              disabled={isExportingPdf}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl bg-red-600 hover:bg-red-700 text-white shadow-sm transition-all disabled:opacity-50"
            >
              {isExportingPdf ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> جاري تجهيز A4 PDF...
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" /> تحميل A4 PDF
                </>
              )}
            </button>

            <button
              onClick={handleDownloadTxt}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition-all"
            >
              <FileDown className="h-3.5 w-3.5" /> تصدير TXT
            </button>
          </div>
        </div>
      )}

      {/* Main Preview Container (Prints / Exports cleanly) */}
      <div ref={mode === 'audio' ? undefined : previewRef} data-pdf-export-root="true" className="space-y-6 export-capture-root">
        {mode === 'audio' && audioResult && (
          <div className="pdf-export-card rounded-3xl bg-white p-5 md:p-6 border border-slate-200 shadow-sm">
            {renderGeneratedPreview()}
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 3: Audio Transcription Result View                  */}
        {/* ======================================================== */}
        {mode === 'audio' && audioResult && (
          <div className="pdf-export-card rounded-3xl bg-white p-6 md:p-8 border border-slate-200 shadow-sm space-y-6">
            <div className="border-b border-slate-200 pb-5">
              <span className="inline-flex items-center gap-1 text-xs font-bold bg-purple-50 text-purple-700 px-3 py-1 rounded-full border border-purple-200 mb-2">
                <Mic className="h-3 w-3" /> تفريغ ومذكرات المحاضرة
              </span>
              <h2 className="text-xl md:text-2xl font-black text-slate-900">{audioResult.title}</h2>
              <p className="text-xs text-slate-500 mt-1">الملف: {audioResult.fileName}</p>
            </div>

            {/* Key Takeaways */}
            {audioResult.keyTakeaways && audioResult.keyTakeaways.length > 0 && (
              <div className="bg-purple-50/60 p-4 rounded-2xl border border-purple-200">
                <h4 className="text-sm font-bold text-purple-900 mb-2 flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-purple-600" /> أهم النقاط المستخلصة من المحاضرة
                </h4>
                <ul className="list-disc list-inside space-y-1 text-xs md:text-sm text-purple-950 font-medium">
                  {audioResult.keyTakeaways.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Structured Sections */}
            <div className="space-y-4">
              <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-purple-600" /> أقسام وتفاصيل المحاضرة
              </h3>
              {audioResult.sections.map((sec, idx) => (
                <div key={idx} className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-3">
                  <h4 className="font-bold text-slate-900 text-sm md:text-base flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-purple-600 text-white text-xs">
                      {idx + 1}
                    </span>
                    {sec.heading}
                  </h4>
                  <p className="text-sm text-slate-700 leading-relaxed">{sec.body}</p>
                  {sec.points && sec.points.length > 0 && (
                    <ul className="list-disc list-inside space-y-1 text-xs md:text-sm text-slate-600 pl-2">
                      {sec.points.map((pt, pIdx) => (
                        <li key={pIdx}>{pt}</li>
                      ))}
                    </ul>
                  )}
                  {sec.doctorTipAr && (
                    <div className="bg-amber-50 p-3 rounded-xl border border-amber-200 text-xs md:text-sm text-amber-900 font-cairo">
                      <strong>💡 ملاحظة مراجعة:</strong> {sec.doctorTipAr}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Full Transcript Accordion */}
            <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="font-bold text-xs text-slate-700 cursor-pointer flex items-center justify-between">
                <span>عرض التفريغ الكامل للمحاضرة (Full Transcript)</span>
                <ChevronRight className="h-4 w-4 text-slate-400" />
              </summary>
              <div className="mt-4 p-4 bg-white rounded-xl border border-slate-200 text-xs md:text-sm text-slate-600 leading-relaxed font-mono whitespace-pre-wrap max-h-96 overflow-y-auto">
                {audioResult.transcript}
              </div>
            </details>
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 1: Show ALL Slide Pages & Egyptian Explanations     */}
        {/* ======================================================== */}
        {mode === 'full' && slideGroups.length > 0 && (
          <div className="space-y-8">
            {slideGroups.map((group, gIdx) => (
              <div
                key={group.id}
                data-export-group="true"
                className="pdf-export-card rounded-3xl bg-white p-4 md:p-5 border border-slate-200 shadow-sm transition-all hover:shadow-md"
              >
                {/* Header Badge */}
                <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-600 text-white text-xs font-bold">
                      <Layers className="h-3.5 w-3.5" />
                      {group.startSlide === group.endSlide
                        ? `شريحة ${group.startSlide}`
                        : `الشرائح ${group.startSlide} إلى ${group.endSlide}`}
                    </span>
                    {group.explanation?.isRecovered && (
                      <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full border border-amber-300">
                        تم استردادها عبر Recovery Engine
                      </span>
                    )}
                    {group.explanation?.isLocalFallback && (
                      <span className="text-[10px] font-bold bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full border border-blue-300">
                        نسخة احتياطية محلية
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 font-mono">
                    قسم {gIdx + 1} من {slideGroups.length}
                  </span>
                </div>

                {/* Slides Visual Grid (Shows ALL pages in this group) */}
                <div className={`grid gap-3 mb-4 ${group.pages.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
                  {group.pages.map((page) => (
                    <div
                      key={page.index}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-2 text-center shadow-sm flex flex-col items-center"
                    >
                      <div className="w-full flex items-center justify-between text-[11px] font-bold text-slate-500 mb-1.5 px-1">
                        <span>Slide #{page.index}</span>
                        <span>{page.text ? `${page.text.length} حرف` : 'رسم / صورة'}</span>
                      </div>
                      {page.img ? (
                        <div className="w-full rounded-xl overflow-hidden border border-slate-200 bg-white">
                          <img
                            data-pdf-slide-image="true"
                            src={page.img}
                            alt={`Slide ${page.index}`}
                            className="w-full h-auto object-contain max-h-[360px] md:max-h-[620px] mx-auto"
                            loading="lazy"
                          />
                        </div>
                      ) : (
                        <div className="w-full py-16 bg-slate-100 rounded-xl text-xs text-slate-400 font-mono">
                          صورة الشريحة غير متوفرة (تم الحفاظ على النص)
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Egyptian Arabic Explanation Card */}
                {group.explanation && (
                  <div
                    dir="rtl"
                    className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 shadow-sm font-cairo"
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3 mb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                          <GraduationCap className="h-4 w-4" />
                        </div>
                        <div>
                          <h3 className="text-sm md:text-base font-black text-slate-900">
                            {group.explanation.topic}
                          </h3>
                          <p className="text-[11px] text-emerald-700 font-semibold">
                            ملخص سريع ومفاهيم رئيسية
                          </p>
                        </div>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                        Key idea
                      </span>
                    </div>

                    {group.explanation.conceptSummary && (
                      <div className="mb-3 rounded-xl border border-emerald-200 bg-white p-2.5">
                        <p className="text-xs md:text-sm font-bold text-emerald-900 leading-relaxed">
                          <span className="underline decoration-emerald-400">الفكرة الأساسية:</span>{' '}
                          {group.explanation.conceptSummary}
                        </p>
                      </div>
                    )}

                    <ul className="space-y-2 text-slate-800 text-xs md:text-sm leading-relaxed">
                      {group.explanation.paragraphs.map((p, pIdx) => (
                        <li key={pIdx} className="rounded-xl border border-slate-200 bg-white p-2.5 list-disc list-inside marker:text-emerald-700">
                          {p}
                        </li>
                      ))}
                    </ul>

                    {group.explanation.doctorTips && group.explanation.doctorTips.length > 0 && (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
                        <h4 className="text-[11px] md:text-xs font-black text-amber-900 mb-2 flex items-center gap-2">
                          <Flame className="h-3.5 w-3.5 text-amber-600" /> نقاط المراجعة السريعة:
                        </h4>
                        <ul className="list-disc list-inside space-y-1 text-[11px] md:text-xs text-amber-950 font-medium">
                          {group.explanation.doctorTips.map((tip, tIdx) => (
                            <li key={tIdx}>{tip}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {group.explanation.keyTerms && group.explanation.keyTerms.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-slate-200 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-500">المصطلحات:</span>
                        {group.explanation.keyTerms.map((term, kIdx) => (
                          <span
                            key={kIdx}
                            className="inline-flex items-center gap-1.5 bg-white px-2.5 py-1 rounded-lg border border-slate-200 text-[10px] font-bold text-slate-700"
                          >
                            <span className="font-mono text-slate-900">{term.term}</span>
                            <span className="text-[10px] text-emerald-700">({term.meaningAr})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ======================================================== */}
        {/* DOCTOR EXAM QUESTIONS (MCQs & Essays)                    */}
        {/* ======================================================== */}
        {(mcqs.length > 0 || essays.length > 0) && (
          <div className="pdf-export-card rounded-3xl bg-white p-6 md:p-8 border border-slate-200 shadow-sm space-y-8">
            <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="inline-flex items-center gap-1 text-xs font-bold bg-amber-50 text-amber-800 px-3 py-1 rounded-full border border-amber-200 mb-1.5">
                  <GraduationCap className="h-3.5 w-3.5" /> بنك أسئلة امتحانات الجامعات
                </span>
                <h3 className="text-lg md:text-xl font-black text-slate-900">
                  أسئلة مراجعة على نمط الامتحانات
                </h3>
              </div>
              <span className="text-xs font-bold bg-slate-100 text-slate-700 px-3 py-1 rounded-xl">
                مستوى الصعوبة: {difficulty.toUpperCase()}
              </span>
            </div>

            {/* MCQs Section */}
            {mcqs.length > 0 && (
              <div className="space-y-5">
                <h4 className="font-bold text-slate-900 text-sm md:text-base flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-emerald-600" /> أسئلة الاختيار من متعدد (Multiple Choice Questions)
                </h4>

                <div className="grid grid-cols-1 gap-4">
                  {mcqs.map((q, idx) => {
                    const selected = userAnswers[idx];
                    const isAnswered = Boolean(selected);

                    return (
                      <div
                        key={idx}
                        data-export-page="true"
                        data-export-page-kind="mcq"
                        data-export-number={idx + 1}
                        data-export-title="أسئلة الاختيار من متعدد"
                        data-export-subtitle={`سؤال ${idx + 1}`}
                        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 space-y-3 transition-all hover:bg-slate-50"
                      >
                        <div data-pdf-question="true" className="flex items-start justify-between gap-2">
                          <p className="font-bold text-sm md:text-base text-slate-900 leading-relaxed">
                            <span className="text-emerald-700 font-extrabold ml-1">Q{idx + 1}:</span> {q.question}
                          </p>
                          {q.difficulty && (
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase flex-shrink-0 ${
                                q.difficulty.toLowerCase() === 'hard'
                                  ? 'bg-red-100 text-red-800 border border-red-200'
                                  : q.difficulty.toLowerCase() === 'medium'
                                  ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                  : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              }`}
                            >
                              {q.difficulty}
                            </span>
                          )}
                        </div>

                        {/* Options */}
                        <div data-pdf-options="true" className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                          {q.options.map((opt, optIdx) => {
                            const optLetter = opt.charAt(0).toUpperCase();
                            const isCorrect = q.answer && q.answer.trim().startsWith(optLetter);
                            const isSelected = selected === optLetter;

                            let btnStyle = 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400';
                            if (isSelected) {
                              btnStyle = isCorrect
                                ? 'bg-emerald-500 text-white border-emerald-600 shadow-sm'
                                : 'bg-red-500 text-white border-red-600 shadow-sm';
                            } else if (showAnswers && isCorrect) {
                              btnStyle = 'bg-emerald-100 text-emerald-900 border-emerald-300 font-bold';
                            }

                            return (
                              <button
                                key={optIdx}
                                onClick={() => setUserAnswers((prev) => ({ ...prev, [idx]: optLetter }))}
                                className={`text-left p-3 rounded-xl border text-xs md:text-sm font-medium transition-all flex items-center justify-between ${btnStyle}`}
                              >
                                <span>{opt}</span>
                                {isSelected && (isCorrect ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />)}
                              </button>
                            );
                          })}
                        </div>

                        {/* Explanation & Doctor Note */}
                        {(showAnswers || isAnswered) && (
                          <div className="mt-3 pt-3 border-t border-slate-200 space-y-2">
                            {q.answer && (
                              <div data-pdf-correct-answer="true" className="flex items-center gap-2 text-xs font-bold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                                <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                                <span>الإجابة الصحيحة: {q.answer}</span>
                              </div>
                            )}

                            {q.explanation && (
                              <div data-pdf-answer-detail="true" className="text-xs text-slate-700 bg-white p-3 rounded-xl border border-slate-200 leading-relaxed">
                                <strong className="text-slate-900">التعليل والشرح: </strong>
                                {q.explanation}
                              </div>
                            )}

                            {q.doctorNoteAr && (
                              <div data-pdf-answer-detail="true" dir="rtl" className="text-xs text-amber-950 bg-amber-50/90 p-3 rounded-xl border border-amber-200 font-cairo">
                                <strong>💡 ملاحظة مراجعة: </strong>
                                {q.doctorNoteAr}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Essays Section */}
            {essays.length > 0 && (
              <div className="space-y-4 pt-4 border-t border-slate-200">
                <h4 className="font-bold text-slate-900 text-sm md:text-base flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-600" /> الأسئلة المقالية النموذجية (Essay / Problem Questions)
                </h4>

                <div className="space-y-4">
                  {essays.map((eq, idx) => (
                    <div key={idx} data-export-page="true" data-export-page-kind="essay" data-export-number={mcqs.length + idx + 1} data-export-title="الأسئلة المقالية النموذجية" data-export-subtitle={`السؤال المقالي ${idx + 1}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-3">
                      <div data-pdf-question="true" className="flex items-start justify-between gap-2">
                        <p className="font-bold text-sm md:text-base text-slate-900 leading-relaxed">
                          <span className="text-amber-700 font-extrabold ml-1">س{idx + 1}:</span> {eq.question}
                        </p>
                        {eq.difficulty && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-slate-200 text-slate-800">
                            {eq.difficulty}
                          </span>
                        )}
                      </div>

                      {showAnswers && (
                        <div data-pdf-answer-detail="true" className="space-y-2.5 pt-2">
                          <div className="bg-white p-4 rounded-xl border border-slate-200 text-xs md:text-sm text-slate-800 leading-relaxed">
                            <strong className="text-emerald-800 block mb-1">النموذج المثالي للإجابة:</strong>
                            <p className="whitespace-pre-line">{eq.answer}</p>
                          </div>

                          {eq.rubricPoints && eq.rubricPoints.length > 0 && (
                            <div className="bg-blue-50/80 p-3.5 rounded-xl border border-blue-200 text-xs text-blue-950">
                              <strong className="block mb-1 text-blue-900">عناصر تقييم وتوزيع درجات الدكتور:</strong>
                              <ul className="list-disc list-inside space-y-1">
                                {eq.rubricPoints.map((pt, rIdx) => (
                                  <li key={rIdx}>{pt}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {eq.doctorNoteAr && (
                            <div dir="rtl" className="bg-amber-50 p-3 rounded-xl border border-amber-200 text-xs text-amber-950 font-cairo">
                              <strong>💡 نصيحة المراجعة:</strong> {eq.doctorNoteAr}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Info */}
      <footer className="no-print mt-12 text-center text-xs text-slate-400 py-6 border-t border-slate-200/80">
        <p>PDF Study Guide • Arabic Review • Built for quick revision and exam prep</p>
      </footer>
    </div>
  );
}
