/** 计算文本 SHA-256（现代浏览器与 Node 18+ 均内置 Web Crypto） */
export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
