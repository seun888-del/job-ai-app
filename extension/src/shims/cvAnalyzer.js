// The extension reads PDFs itself (lib/cvtext.js); the importer only needs the text step.
module.exports = { extractPdfText: async () => { throw new Error('Use importTracText in the extension'); } };
