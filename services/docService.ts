import { DocumentFile } from "../types";

const makeId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `doc_${Math.random().toString(36).slice(2, 11)}`;
};

export const parseFileContent = async (file: File): Promise<DocumentFile> => {
  const type = file.type;
  let content = "";
  let docType: 'pdf' | 'docx' | 'txt' = 'txt';
  let pageCount: number | undefined;

  const lowerName = file.name.toLowerCase();

  if (type === "application/pdf" || lowerName.endsWith(".pdf")) {
    docType = 'pdf';
    try {
      // @ts-ignore - loaded via CDN in index.html
      const pdfjsLib = window['pdfjs-dist/build/pdf'];
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument(arrayBuffer);
      const pdf = await loadingTask.promise;
      pageCount = pdf.numPages;
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        content += `[Page ${i}]\n${pageText}\n\n`;
      }
    } catch (e: any) {
      throw new Error("Failed to parse PDF: " + e.message);
    }
  } else if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lowerName.endsWith(".docx")) {
    docType = 'docx';
    try {
      // @ts-ignore - loaded via CDN in index.html
      const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      content = result.value;
    } catch (e: any) {
      throw new Error("Failed to parse DOCX: " + e.message);
    }
  } else {
    content = await file.text();
  }

  return {
    id: makeId(),
    name: file.name,
    content,
    fileObj: file,
    type: docType,
    sizeBytes: file.size,
    charCount: content.length,
    pageCount
  };
};
