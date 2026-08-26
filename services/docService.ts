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

      let totalText = "";
      const pageImages: { mime: string, data: string }[] = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        totalText += `[Page ${i}]\n${pageText}\n\n`;

        // If it looks like a scan (very little text), or for broad support,
        // we can pre-render the page to a canvas for OCR/Vision
        // For efficiency, we only do this if text is sparse or if explicitly needed.
        if (pageText.trim().length < 20) {
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          if (context) {
            await page.render({ canvasContext: context, viewport }).promise;
            const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            pageImages.push({ mime: 'image/jpeg', data: base64 });
          }
        }
      }
      content = totalText;
      return {
        id: Math.random().toString(36).substring(7),
        name: file.name,
        content,
        fileObj: file,
        type: docType,
        images: pageImages.length > 0 ? pageImages : undefined
      };
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