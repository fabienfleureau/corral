// The request form of the files attached to a prompt (browser only: it reads
// the files, so it lives apart from the rules in attachments.ts).

import type { AttachmentInput } from "./attachments";

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** The request form of the attached files. A pasted screenshot has no name. */
export function toAttachmentInputs(files: File[]): Promise<AttachmentInput[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name || "image.png",
      content_type: file.type,
      data: await readBase64(file),
    })),
  );
}
