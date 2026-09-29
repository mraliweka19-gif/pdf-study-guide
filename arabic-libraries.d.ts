declare module 'arabic-reshaper' {
  const reshaper: {
    convertArabic: (text: string) => string;
    convertArabicBack?: (text: string) => string;
  };

  export default reshaper;
}

declare module 'bidi-js' {
  type ParagraphInfo = {
    start: number;
    end: number;
    level: number;
  };

  type EmbeddingLevelsResult = {
    levels: Uint8Array;
    paragraphs: ParagraphInfo[];
  };

  interface BidiObject {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevelsResult;
    getReorderSegments(text: string, embeddingLevels: EmbeddingLevelsResult, start?: number, end?: number): Array<[number, number]>;
    getMirroredCharactersMap(text: string, embeddingLevels: EmbeddingLevelsResult, start?: number, end?: number): Map<number, string>;
    getMirroredCharacter(character: string): string | null;
    getBidiCharTypeName(char: string): string;
  }

  function bidiFactory(): BidiObject;

  export default bidiFactory;
}
