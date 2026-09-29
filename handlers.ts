import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Load local env files when running outside a managed platform (dev / Cloud Run).
// On Vercel these files are absent and env vars are injected by the platform, so
// dotenv is a harmless no-op there.
dotenv.config({ path: '.env.local' });
dotenv.config();

export interface ApiResult {
  status: number;
  data: any;
}

// 10-minute budget for a single Gemini request so slow/large payloads
// (slide images, long digests, audio) are not aborted prematurely.
export const GEMINI_TIMEOUT_MS = 10 * 60 * 1000;

// Shared Gemini client with required User-Agent header
const apiKey = process.env.GEMINI_API_KEY || '';
export const ai = new GoogleGenAI({
  apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export function extractJsonSafe(raw: string) {
  if (!raw) return {};
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.substring(first, last + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return {};
    }
  }
}

// Prioritize high-quota, high-speed models on the free tier (3.1-flash-lite and 3.5-flash-lite)
// to prevent 429 RESOURCE_EXHAUSTED errors from 3.8-flash (which has a strict 20 RPD free tier limit).
export const MODEL_CANDIDATES = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

// In-memory set to remember models that have exhausted their quota for the day.
// Note: on serverless this is best-effort and only lives for the duration of a warm instance.
export const quotaExhaustedModels = new Set<string>();

export async function callGeminiWithFallback(contents: any, systemInstruction: string, temperature = 0.7) {
  let lastError: any = null;

  const generateWithTimeout = async (model: string) => {
    const timeoutMs = GEMINI_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms for model ${model}`)), timeoutMs);
    });

    return Promise.race([
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature,
        },
      }),
      timeoutPromise,
    ]);
  };

  for (const model of MODEL_CANDIDATES) {
    if (quotaExhaustedModels.has(model)) {
      continue;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await generateWithTimeout(model);
        const raw = response.text || '{}';
        const parsed = extractJsonSafe(raw);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return parsed;
        }
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);
        console.warn(`Model ${model} attempt ${attempt} failed:`, msg);

        const isQuotaExhausted = /RESOURCE_EXHAUSTED|quota.*exceeded|quotaValue|GenerateRequestsPerDay/i.test(msg);
        if (isQuotaExhausted) {
          console.warn(`Model ${model} quota exhausted. Immediately switching to next candidate model.`);
          quotaExhaustedModels.add(model);
          break;
        }

        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }

  throw lastError || new Error('All Gemini model candidates failed');
}

/**
 * Explain a slide group in rich Egyptian Arabic.
 */
export async function explainSlide(body: any): Promise<ApiResult> {
  try {
    const {
      slideNumber,
      totalSlides,
      extractedText,
      previousTopics = [],
      slideImageBase64,
    } = body;

    if (!extractedText && !slideImageBase64) {
      return { status: 400, data: { error: 'Missing text or slide image' } };
    }

    const prevList = (previousTopics && previousTopics.length)
      ? previousTopics.slice(-4).map((t: string) => `- ${t}`).join('\n')
      : '(بداية المحاضرة)';

    const systemInstruction = `إنت أستاذ دكتور جامعي مصري خبير جداً في المادة، ومعروف بأسلوبك الأكاديمي الشيق والممتع بالعامية المصرية الراقية.
مهمتك: تشرح محتوى السلايد للطالب بشكل مختصر وواضح وعملي، بحيث يكون الشرح في 2-3 فقرات فقط، كل فقرة 2-4 جمل كحد أقصى، ما يتعدىش 10-12 جملة في المجموع. هذا مهم جداً، لأن الطالب يحتاج شرح سريع ولكن مفهوم.
لا تستخدم النقاط أو التعداد في جسم الشرح، بل فقرات نثرية قصيرة وممتعة علمياً.
ركز على:
1. المفهوم الأساسي وأصله وليه بندرسه.
2. طريقة العمل (Mechanism / Workflow) باختصار.
3. مثال عملي مختصر.
4. تريكة امتحانية أو ملاحظة سريعة فقط.

يجب إرجاع النتيجة بصيغة JSON حصراً بدون علامات كود أو نصوص إضافية. كل حقل يجب أن يكون مختصر ودقيق.`;

    const promptText = `سلايد رقم ${slideNumber || 1} من إجمالي ${totalSlides || 1}.
المواضيع اللي اتشرحت قبل كدا عشان ماتكررهاش:
${prevList}

محتوى السلايد النصي:
"""
${extractedText || 'انظر صورة الشريحة المرفقة'}
"""

اشرح السلايد دي بدقة بالعامية المصرية الأكاديمية الشاملة.
أرجع JSON مطابق لهذا الهيكل:
{
  "topic": "عنوان قصير جذاب للموضوع بالعربي (4-7 كلمات)",
  "conceptSummary": "ملخص الفكرة الجوهرية في جملتين كحد أقصى بالعامية المصرية",
  "paragraphs": [
    "فقرة قصيرة 1: المفهوم والتعريف وأصله وليه بندرسه...",
    "فقرة قصيرة 2: طريقة الشغل أو الميكانيزم باختصار...",
    "فقرة قصيرة 3: مثال عملي أو تريكة امتحانية..."
  ],
  "doctorTips": [
    "تريكاية امتحانية قصيرة",
    "ملاحظة سريعة للطلاب"
  ],
  "keyTerms": [
    { "term": "المصطلح بالإنجليزية", "meaningAr": "معناه بالعربي" }
  ]
}

مهم جداً: لا تكتب أكثر من 3 فقرات، وكل فقرة لا تزيد عن 3-4 جمل فقط، وإجمالي الشرح لا يتعدى 10-12 جملة في المجموع.`;

    const parts: any[] = [];
    if (slideImageBase64 && typeof slideImageBase64 === 'string' && slideImageBase64.includes('base64,')) {
      const mime = slideImageBase64.split(';')[0].replace('data:', '') || 'image/jpeg';
      const cleanData = slideImageBase64.split('base64,')[1];
      parts.push({
        inlineData: {
          mimeType: mime,
          data: cleanData,
        },
      });
    }
    parts.push({ text: promptText });

    const contents = parts.length > 1 ? { parts } : promptText;
    const data = await callGeminiWithFallback(contents, systemInstruction, 0.65);
    return { status: 200, data };
  } catch (error: any) {
    console.warn('Gemini explain-slide failed, generating rich academic Egyptian fallback:', error?.message || error);
    const { slideNumber = 1, extractedText = '' } = body;

    // Synthesize authentic academic Egyptian Arabic explanation from extracted text
    const cleanLines = String(extractedText).split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 5);
    const rawSentences = String(extractedText).split(/[.!?؛]\s+/).map((s: string) => s.trim()).filter((s: string) => s.length > 15);
    const mainTopic = cleanLines[0] || `سلايد ${slideNumber}`;

    const p1 = rawSentences[0]
      ? `الموضوع هنا بيبدأ من نقطة جوهرية: ${rawSentences[0]}. الفكرة ببساطة إننا لما بندرس المفهوم ده، بنفهم الأساس اللي مبني عليه باقي محتوى المحاضرة، وده بيسهل علينا نربط العلاقات بين العناصر المختلفة.`
      : `في السلايد دي بنركز على مفهوم أساسي من موضوعات المادة، والهدف إننا نستوعب الفكرة العامة بدقة قبل ما ندخل في تفاصيل المعادلات والتطبيقات.`;

    const p2 = rawSentences[1] || rawSentences[0]
      ? `نيجي بقى للميكانيزم وطريقة الشغل: ${rawSentences[1] || rawSentences[0]}. العملية دي بتتم بخطوات متتالية بحيث كل خطوة بتسلم اللي بعدها، ولازم تكون واخد بالك كويس من الترتيب والشروط الحاكمة لكل مرحلة.`
      : `طريقة العمل بتعتمد على تسلسل الخطوات الواردة في السلايد، بحيث تتكامل كل مرحلة لتحقيق النتيجة المطلوبة في النظام الأكاديمي والعملي.`;

    const p4 = `تركات الامتحان وملاحظات الدكتور: ركز جداً على المصطلحات الدقيقة وتفريقها عن المصطلحات المشابهة، لأن الدكتور بيحب يجيب أسئلة الـ MCQs بتغيير كلمة واحدة في التعريف أو عكس اتجاه العلاقة بين المتغيرات.`;

    const fallbackData = {
      topic: `${mainTopic.slice(0, 50)}`,
      conceptSummary: `الشريحة دي بتوضح المفهوم المحوري المتعلق بـ "${mainTopic.slice(0, 40)}" بطريقة مختصرة وواضحة.`,
      paragraphs: [
        p1.slice(0, 260),
        p2.slice(0, 260),
        p4.slice(0, 220),
      ],
      doctorTips: [
        `احفظ المصطلحات والعلاقات الأساسية الواردة في السلايد، خاصة المتغيرات والشروط.`,
        `انتبه للفرق بين النتيجة الإجمالية والصافية أو الاتجاهات العكسية التي يعتمد عليها أستاذ المادة.`
      ],
      keyTerms: cleanLines.slice(0, 3).map((line: string) => ({
        term: line.slice(0, 35),
        meaningAr: `مفهوم أو مصطلح رئيسي وارد في شريحة المحاضرة.`
      })),
      isLocalFallback: true
    };

    return { status: 200, data: fallbackData };
  }
}

/**
 * Generate University Doctor-Level Questions (MCQs + Essays).
 */
export async function generateQuestions(body: any): Promise<ApiResult> {
  try {
    const {
      contentDigest,
      mcqCount = 5,
      essayCount = 2,
      difficulty = 'mixed',
      avoidQuestions = [],
    } = body;

    if (!contentDigest || contentDigest.trim().length < 20) {
      return { status: 400, data: { error: 'Content digest is too short or empty' } };
    }

    const avoid = (avoidQuestions && avoidQuestions.length)
      ? 'Avoid duplicating or paraphrasing these existing questions:\n' +
        avoidQuestions.slice(-10).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n') + '\n\n'
      : '';

    const systemInstruction = `You are an elite university professor and exam board chairman (أستاذ دكتور ورئيس لجنة الامتحانات).
You design high-yield, authentic university exam questions that college professors actually ask in midterms and finals.
Rules for Questions:
1. High Cognitive Level:
   - Include realistic scenarios, clinical or operational vignettes, mechanism-based problems, and comparative analyses ("Why does X occur instead of Y?", "Under which circumstance does...", "What is the primary determining factor...", "A student notices X; what is the most likely cause?").
   - AVOID trivial rote definitions or obvious giveaways.
2. Distractor Quality:
   - For MCQs, distractors must be plausible, sophisticated, and reflect common student misconceptions or inverted relationships.
   - Exactly 4 options (A, B, C, D) with exactly one incontrovertibly correct answer.
   - For each MCQ, provide a thorough explanation of why the correct option is right AND why each distractor is wrong, plus a short Egyptian Arabic "Doctor's Note" (ملاحظة الدكتور) explaining the trick!
3. Essay Questions:
   - Frame essays like comprehensive exam prompts ("Discuss the mechanism of...", "Compare and contrast X and Y regarding...", "Analyze the consequences of...").
   - Provide a model answer with clear rubric bullet points that an exam grader expects.
4. Difficulty Level: ${difficulty.toUpperCase()}.`;

    const userPrompt = `SOURCE CONTENT DIGEST FROM LECTURE:
"""
${contentDigest}
"""

${avoid}
TASK:
Generate EXACTLY ${mcqCount} Multiple Choice Questions (MCQs) and ${essayCount} Essay Questions based strictly on the source lecture material above.

Format your response as valid JSON matching this schema:
{
  "mcqs": [
    {
      "question": "Scenario/conceptual question stem...",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "answer": "A) ...",
      "difficulty": "Easy" | "Medium" | "Hard",
      "explanation": "Detailed explanation of why this answer is correct and why other options fail...",
      "doctorNoteAr": "تريكاية السؤال ده بالعامية المصرية وملاحظة الدكتور للطلاب..."
    }
  ],
  "essays": [
    {
      "question": "Comprehensive essay question...",
      "difficulty": "Easy" | "Medium" | "Hard",
      "answer": "Structured model answer containing full key points and mechanisms...",
      "rubricPoints": ["Key point 1 expected for full marks", "Key point 2...", "Key point 3..."],
      "doctorNoteAr": "ازاي الدكتور بيصحح السؤال ده والكلمات المفتاحية المطلوبة..."
    }
  ]
}`;

    const data = await callGeminiWithFallback(userPrompt, systemInstruction, 0.75);

    return {
      status: 200,
      data: {
        mcqs: Array.isArray(data?.mcqs) ? data.mcqs : [],
        essays: Array.isArray(data?.essays) ? data.essays : [],
      },
    };
  } catch (error: any) {
    console.warn('Gemini questions generation failed, creating high-yield fallback exam set:', error?.message || error);
    const { contentDigest = '', mcqCount = 5, essayCount = 2, difficulty = 'medium' } = body;

    // Extract key sentences and concept fragments from the digest
    const sentences = String(contentDigest)
      .split(/[.!?؛\n]+/)
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 25 && s.length < 250);

    const fallbackMcqs = [];
    for (let i = 0; i < mcqCount; i++) {
      const s = sentences[i % Math.max(1, sentences.length)] || 'The fundamental concept outlined in the lecture material';
      const cleanStmt = s.replace(/^\[Slide \d+\]:?\s*/i, '');

      const correctOpt = `A) It is directly established that: "${cleanStmt.slice(0, 100)}"`;
      const wrong1 = `B) It acts inversely to the principles stated in the lecture`;
      const wrong2 = `C) It operates independently without requiring foundational conditions`;
      const wrong3 = `D) None of the mechanisms described above are applicable`;

      fallbackMcqs.push({
        question: `Based on the lecture analysis, which of the following statements accurately represents the primary principle regarding: "${cleanStmt.slice(0, 80)}..."?`,
        options: [correctOpt, wrong1, wrong2, wrong3],
        answer: correctOpt,
        difficulty: difficulty === 'hard' ? 'Hard' : (difficulty === 'easy' ? 'Easy' : 'Medium'),
        explanation: `According to the lecture text, "${cleanStmt}" is the verified correct mechanism. Options B, C, and D contradict the lecture evidence.`,
        doctorNoteAr: `السؤال ده بيقيس استيعابك للنص المباشر وقدرتك على تمييز المعلومة المؤكدة من المشتتات العكسية اللي الدكتور بيحطها في الامتحان.`
      });
    }

    const fallbackEssays = [];
    for (let j = 0; j < essayCount; j++) {
      const s = sentences[(j + 2) % Math.max(1, sentences.length)] || 'The structural and operational principles of the topic';
      const cleanStmt = s.replace(/^\[Slide \d+\]:?\s*/i, '');

      fallbackEssays.push({
        question: `Critically evaluate and explain the core mechanism and implications of the following concept discussed in the lecture: "${cleanStmt.slice(0, 120)}".`,
        difficulty: difficulty === 'hard' ? 'Hard' : 'Medium',
        answer: `A comprehensive answer requires defining the foundational concept (${cleanStmt}), explaining the step-by-step mechanism, evaluating the governing factors, and demonstrating its practical application and outcomes as demonstrated in the lecture slides.`,
        rubricPoints: [
          `Clear definition and context of the core concept.`,
          `Accurate step-by-step breakdown of the underlying mechanism.`,
          `Identification of limiting factors, dependencies, and key outcomes.`,
          `Integration with the overall lecture objectives.`
        ],
        doctorNoteAr: `أستاذ المادة بيبحث في إجابة السؤال المقالي ده عن التسلسل المنطقي وذكر الكلمات المفتاحية الأساسية وليس مجرد السرد العشوائي.`
      });
    }

    return {
      status: 200,
      data: {
        mcqs: fallbackMcqs,
        essays: fallbackEssays,
        isFallback: true
      }
    };
  }
}

/**
 * Transcribe and organize audio into university study notes.
 */
export async function transcribeAudio(body: any): Promise<ApiResult> {
  try {
    const { audioBase64, mimeType = 'audio/mp3', fileName = 'Lecture Audio' } = body;

    const fallbackData = {
      title: String(fileName || 'محاضرة مسجلة').replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
      transcript: 'تم استقبال الملف الصوتي ومعالجته داخل النظام الأكاديمي. لم يتم الوصول إلى خدمة الصوت في الوقت الحالي، لذلك تم إرجاع ملخص صوتي احتياطي منسق.',
      sections: [
        {
          heading: 'ملخص المحاضرة والمحتوى الصوتي',
          body: 'تم استلام التسجيل وحفظ بياناته. إذا كانت خدمة الذكاء الاصطناعي متاحة لاحقاً، يمكن استبدال هذا الملخص بتنظيم كامل من النصوص الدقيقة.',
          points: ['تسجيل المحاضرة كامل', 'تجهيز نقاط المراجعة الأكاديمية', 'تنظيم المحتوى في أقسام واضحة'],
          doctorTipAr: 'راجع الأفكار الرئيسية في التسجيل مع الشرائح المرفقة لتحقيق أقصى استفادة.'
        }
      ],
      keyTakeaways: ['المراجعة المنتظمة للمحاضرة', 'التركيز على تنبيهات الدكتور', 'تجهيز ملخصات للامتحان النهائي'],
      isFallback: true,
    };

    if (!audioBase64) {
      return { status: 400, data: { error: 'Missing audio data', ...fallbackData } };
    }

    if (!process.env.GEMINI_API_KEY) {
      return { status: 200, data: fallbackData };
    }

    const cleanBase64 = audioBase64.includes('base64,')
      ? audioBase64.split('base64,')[1]
      : audioBase64;

    const audioPart = {
      inlineData: {
        mimeType: mimeType || 'audio/mp3',
        data: cleanBase64,
      },
    };

    const textPart = {
      text: `Transcribe this lecture recording accurately.
Then organize it into comprehensive university study notes with:
1. Complete transcript.
2. Clear chapter/section headings with detailed explanations and bullet points.
3. Summary of key points and doctor's exam hints in Egyptian Arabic and English.

Return valid JSON:
{
  "transcript": "Full clean verbatim transcript...",
  "title": "Concise Lecture Title",
  "sections": [
    {
      "heading": "Section Heading",
      "body": "Detailed paragraph explaining the concepts...",
      "points": ["Key bullet point 1", "Key bullet point 2"],
      "doctorTipAr": "ملاحظة وتوضيح بالعامية المصرية..."
    }
  ],
  "keyTakeaways": ["Takeaway 1", "Takeaway 2"]
}`,
    };

    let data: any = null;
    const audioModels = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
    for (const m of audioModels) {
      if (quotaExhaustedModels.has(m)) continue;
      try {
        const response = await Promise.race([
          ai.models.generateContent({
            model: m,
            contents: { parts: [audioPart, textPart] },
            config: {
              responseMimeType: 'application/json',
            },
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Gemini audio request timed out after ${GEMINI_TIMEOUT_MS}ms for model ${m}`)), GEMINI_TIMEOUT_MS);
          }),
        ]);
        const raw = response.text || '{}';
        data = extractJsonSafe(raw);
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          break;
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        console.warn(`Audio model ${m} failed:`, msg);
        if (/RESOURCE_EXHAUSTED|quota.*exceeded/i.test(msg)) {
          quotaExhaustedModels.add(m);
        }
      }
    }

    if (!data || typeof data !== 'object' || !data.title) {
      return {
        status: 200,
        data: {
          ...fallbackData,
          title: String(fileName || 'محاضرة مسجلة').replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
        },
      };
    }

    return { status: 200, data };
  } catch (error: any) {
    console.error('Error in transcribe-audio:', error?.message || error);
    const { fileName = 'Lecture Audio' } = body || {};
    return {
      status: 200,
      data: {
        title: String(fileName || 'محاضرة مسجلة').replace(/\.[^.]+$/, '') || 'محاضرة مسجلة',
        transcript: 'تم استقبال الملف الصوتي، لكن الخادم لم يتمكن من إنشاء نص كامل في هذه اللحظة. تم إرجاع نسخة منظمة احتياطية.',
        sections: [
          {
            heading: 'ملخص احتياطي',
            body: 'يُستخدم هذا الملخص كنسخة احتياطية عند فشل خدمة الصوت. يمكن إعادة المحاولة لاحقاً أو استخدام ملف صوتي مختصر.',
            points: ['الاستماع الكامل المسجل', 'تجهيز النقاط الرئيسية', 'التدريب على أسئلة المراجعة'],
            doctorTipAr: 'لتحسين النتيجة، ركز على التلخيص المنظم داخل المحاضرة.'
          }
        ],
        keyTakeaways: ['راجع المحاضرة في جلسات قصيرة', 'ركز على النقاط المكررة', 'حل أسئلة المراجعة'],
        isFallback: true,
      }
    };
  }
}
