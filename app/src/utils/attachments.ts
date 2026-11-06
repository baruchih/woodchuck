// Files staged in an input bar, uploaded only when the message is sent

export interface Attachment {
  id: string;
  file: File;
  /** Images go to the image upload endpoint so the agent can view them */
  image: boolean;
}

/**
 * Build the single-line message sent after the uploads finish. It stays on one
 * line because a newline in session input would submit early.
 */
export function composeAttachmentMessage(text: string, imagePaths: string[], filePaths: string[]): string {
  const parts: string[] = [];
  if (imagePaths.length > 0) {
    parts.push(`${imagePaths.length === 1 ? 'image' : 'images'}: ${imagePaths.join(' ')}`);
  }
  if (filePaths.length > 0) {
    parts.push(`${filePaths.length === 1 ? 'file' : 'files'} (in the session uploads folder): ${filePaths.join(' ')}`);
  }
  const attached = parts.join('; ');
  const trimmed = text.trim();
  if (!attached) return trimmed;
  if (!trimmed) return `I attached ${attached}`;
  return `${trimmed} [attached ${attached}]`;
}
