const msDoc = require('./documentIntelligence');
const { extractUrlStudyText } = require('./urlContent');

/**
 * Normalize uploads / links into plain text for Gemini.
 * - PDF, Word, images → Azure Document Intelligence (when configured)
 * - Plain text files → read locally
 * - YouTube / websites → urlContent transcript / page text
 * - Audio → skipped here (Gemini handles audio directly)
 */
async function resolveStudyMaterial({ text = '', files = [], url = '', urlType = '' } = {}) {
  const pasted = String(text || '').trim();
  const audioOnly = files.length === 1 && msDoc.classifyFile(files[0]) === 'audio';

  if (url) {
    const extracted = await extractUrlStudyText(url, urlType);
    const combined = [pasted, extracted.text].filter(Boolean).join('\n\n').trim();
    return {
      text: combined.slice(0, 500000),
      sourceText: combined.slice(0, 500000),
      inputType: 'url',
      urlMeta: extracted,
      audioOnly: false,
      extraction: {
        provider: extracted.urlType === 'youtube' ? 'youtube-transcript' : 'website',
        extractedCount: 1,
        totalFiles: 0
      }
    };
  }

  if (audioOnly) {
    return {
      text: pasted,
      sourceText: pasted,
      inputType: 'audio',
      urlMeta: null,
      audioOnly: true,
      extraction: { provider: 'gemini-audio', extractedCount: 0, totalFiles: files.length }
    };
  }

  let extraction = { text: '', results: [], extractedCount: 0, totalFiles: files.length, provider: 'none' };
  if (files.length) {
    extraction = await msDoc.extractTextFromFiles(files);
  }

  const combined = [pasted, extraction.text].filter(Boolean).join('\n\n').trim();
  const hasExtractedText = extraction.extractedCount > 0 && extraction.text.length >= 80;
  const inputType = files.length ? 'files' : 'text';

  return {
    text: combined.slice(0, 500000),
    sourceText: combined.slice(0, 500000),
    inputType,
    urlMeta: null,
    audioOnly: false,
    useTextOnlyAi: hasExtractedText,
    extraction: {
      provider: extraction.provider,
      extractedCount: extraction.extractedCount,
      totalFiles: extraction.totalFiles,
      results: extraction.results
    }
  };
}

module.exports = {
  resolveStudyMaterial
};
