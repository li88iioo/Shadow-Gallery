function createNgrams(text, minGram = 1, maxGram = 2) {
    if (typeof text !== 'string') return '';
    const sanitizedText = text.toLowerCase().replace(/\s+/g, '');
    const ngrams = new Set();
    for (let n = minGram; n <= maxGram; n++) {
        for (let i = 0; i < sanitizedText.length - n + 1; i++) {
            ngrams.add(sanitizedText.substring(i, i + n));
        }
    }
    return Array.from(ngrams).join(' ');
}

module.exports = {
    createNgrams
};