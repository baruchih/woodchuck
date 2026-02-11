export function getFolderName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function truncatePath(path: string, maxLength: number = 40): string {
  if (path.length <= maxLength) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
}
