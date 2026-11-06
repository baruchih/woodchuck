import { useState, useCallback } from 'react';
import { composeAttachmentMessage, type Attachment } from '../utils/attachments';
import type { ProgressCallback } from '../api/client';

interface Uploaders {
  uploadImage: (id: string, file: File, onProgress?: ProgressCallback) => Promise<string>;
  uploadFiles: (id: string, files: File[], onProgress?: ProgressCallback) => Promise<string[]>;
}

let nextId = 0;

/** Staged attachments for an input bar; nothing uploads until `uploadAndCompose` */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const addAttachments = useCallback((files: FileList | File[], image?: boolean) => {
    const added = Array.from(files).map((file) => ({
      id: `att-${++nextId}`,
      file,
      image: image ?? file.type.startsWith('image/'),
    }));
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  return { attachments, addAttachments, removeAttachment, clearAttachments };
}

/** Upload every attachment, then build the message to send with `text` */
export async function uploadAndCompose(
  sessionId: string,
  text: string,
  attachments: Attachment[],
  { uploadImage, uploadFiles }: Uploaders,
  onProgress: (pct: number) => void,
): Promise<string> {
  const total = attachments.reduce((sum, a) => sum + a.file.size, 0) || 1;
  let done = 0;
  const report = (bytes: number) => (pct: number) => {
    onProgress(Math.min(100, Math.round(((done + (bytes * pct) / 100) / total) * 100)));
  };

  const imagePaths: string[] = [];
  for (const a of attachments.filter((a) => a.image)) {
    imagePaths.push(await uploadImage(sessionId, a.file, report(a.file.size)));
    done += a.file.size;
  }
  const files = attachments.filter((a) => !a.image).map((a) => a.file);
  let filePaths: string[] = [];
  if (files.length > 0) {
    filePaths = await uploadFiles(sessionId, files, report(files.reduce((s, f) => s + f.size, 0)));
  }
  return composeAttachmentMessage(text, imagePaths, filePaths);
}
