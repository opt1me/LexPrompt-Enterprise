import { DocumentFile } from "../types";

export const parseFileContent = async (file: File): Promise<DocumentFile> => {
  const type = file.type;
  let content = "";
  let docType: 'pdf' | 'docx' | 'txt' = 'txt';

  if (type === "application/pdf") {
    docType = 'pdf';
    try {
      // @ts-ignore - Loaded via CDN in index.html
      const pdfjsLib = window['pdfjs-dist/build/pdf'];
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument(arrayBuffer);
      const pdf = await loadingTask.promise;
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        content += `[Page ${i}]\n${pageText}\n\n`;
      }
    } catch (e: any) {
      throw new Error("Failed to parse PDF: " + e.message);
    }
  } else if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    docType = 'docx';
    try {
      // @ts-ignore - Loaded via CDN
      const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      content = result.value;
    } catch (e: any) {
      throw new Error("Failed to parse DOCX: " + e.message);
    }
  } else {
    content = await file.text();
  }

  return {
    id: Math.random().toString(36).substring(7),
    name: file.name,
    content,
    fileObj: file,
    type: docType
  };
};