export interface ManifestEntry {
  id: string;
  path: string;
  source: string;
  width: number;
  height: number;
}

export function buildManifest(entries: ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted, null, 2) + '\n';
}
